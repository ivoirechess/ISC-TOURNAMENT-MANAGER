# ISC Tournament Manager

Plateforme de gestion de tournois d'échecs pour la Côte d'Ivoire (Ivoire
Chess). Front-end statique + Supabase. Voir `CLAUDE.md` pour l'architecture
et les règles du projet.

## Configuration locale

Le site est statique, sans étape de compilation. Pour activer la connexion
Supabase en local ou sur un hébergement statique :

1. Copier `env.example.js` vers `env.js` (ignoré par git) — les valeurs
   (URL du projet et clé *publishable*/anon) sont publiques par conception ;
   c'est le RLS qui protège les données.
2. Ouvrir `index.html`. Sans `env.js`, le site fonctionne en mode public
   (lecture seule).

La clé **service_role** ne doit jamais apparaître nulle part dans le dépôt.

## Réglages Supabase requis (hors dépôt)

- **Désactiver les inscriptions publiques** : dans le tableau de bord
  Supabase, Authentication → Sign In / Up → décocher « Allow new users to
  sign up ». Le site ne propose aucune inscription (les comptes
  organisateurs sont créés à la main), mais sans ce réglage l'endpoint
  d'inscription resterait appelable directement avec la clé anon. Un tel
  compte n'aurait aucun droit d'écriture (aucune ligne `profiles`), mais
  autant fermer la porte.
- **Créer les comptes admin** : créer l'utilisateur dans Authentication,
  puis insérer sa ligne dans `public.profiles` (rôle `admin` ou
  `super_admin`) via l'éditeur SQL du tableau de bord.

## Tests

```
npm test
```

Lanceur intégré de Node (`node --test`), aucune dépendance.

## Récupération et suppression des tournois

Appliquer la migration Supabase
`20260810120000_tournament_recovery.sql` après toutes les migrations
précédentes. Elle ajoute les journaux append-only de réouverture et de
suppression, `deleted_by`/`deletion_reason`, puis installe les RPC
transactionnelles `reopen_tournament` et `soft_delete_tournament`. Ne modifiez
pas les migrations déjà déployées. Après déploiement, exécuter
`npm run test:rls` contre PostgreSQL avant d'ouvrir l'accès en production.

## RPC de création transactionnelle

`create_tournament_with_players(request_id, tournament_data, player_ids,
schedule, publish_now)` est l'unique chemin de création d'un tournoi complet.

- `request_id` est une clé UUID d'idempotence : un retry ou un double clic
  retourne le tournoi déjà créé. Un verrou transactionnel sérialise deux appels
  concurrents portant la même clé.
- `tournament_data` contient les informations générales, le format, la cadence,
  les départages et les limites d'inscription.
- `player_ids` contient les joueurs, sans doublon.
- `schedule` vaut `null` en Suisse. Pour les formats en cercle, il contient le
  calendrier produit par `src/roundrobin.js`; PostgreSQL en vérifie les rondes,
  tables, joueurs, apparitions, paires, byes et résultats avant insertion.
- `publish_now` publie facultativement le brouillon dans la même transaction.

Toute exception annule le tournoi, ses inscriptions, ses rondes, ses
appariements et la clé d'idempotence. La fonction est exécutable uniquement par
le rôle `authenticated` et revérifie le rôle applicatif côté serveur.

## Annuaire et synchronisation FIDE

L'annuaire public est disponible à `#/joueurs`; une fiche accepte l'UUID local
ou l'identifiant FIDE (`#/joueur/<identifiant>`). Les données FIDE synchronisées
sont visuellement séparées des champs locaux. Un administrateur peut corriger
le club et les notes locales, mais un trigger protège les champs issus de la
liste officielle. L'année de naissance n'est jamais sélectionnée par ces vues.

Le programme `scripts/fide_civ.py` lit les listes mensuelles officielles TXT,
XML ou ZIP et ne conserve que `FED = CIV`. Exemple de contrôle sans écriture :

```sh
python3 scripts/fide_civ.py --input liste.zip --output rapport.json \
  --period 2026-08 --dry-run
```

Avec `--download`, le programme télécharge la liste officielle. Avec `--apply`,
il exige `DATABASE_URL` et effectue un upsert sur `fide_id`; les champs locaux
(`club`, `club_id`, `local_notes`) ne figurent jamais dans la mise à jour. Le
workflow `.github/workflows/fide-civ.yml` exécute cette procédure chaque mois ou
manuellement, puis publie le rapport et son checksum SHA-256.

La RPC `merge_players(source_id, target_id, reason)` est réservée aux
super-administrateurs. Dans une transaction unique, elle verrouille les deux
joueurs, déduplique et déplace inscriptions et appariements, puis marque la
source comme fusionnée. Une raison est obligatoire et une fusion qui créerait
deux apparitions dans la même ronde est refusée.

## Clubs et invitations administrateur

La gestion canonique des clubs requiert ensuite **une seule migration additive** :
`supabase/migrations/20260813120000_canonical_club_management.sql`. Elle rapproche
les anciens clubs texte, installe les RPC transactionnelles de résolution et de
création de joueur, ainsi que les diagnostics et alias. Elle doit être appliquée
après `20260812120000_safe_player_merge.sql`; aucune migration antérieure ne doit
être rejouée ou modifiée.

La migration `20260809120000_club_administration.sql` ajoute les memberships
`owner`/`admin`, les invitations auditées et `tournaments.club_id`. Les règles
RLS donnent accès aux tournois d'un club uniquement à ses membres actifs. Un
administrateur sans membership conserve la gestion de ses anciens tournois
personnels ; un membership désactivé ne donne aucun droit d'écriture.

Déployer la fonction après la migration :

```sh
supabase functions deploy invite-admin --project-ref VOTRE_PROJECT_REF
supabase secrets set PUBLIC_SITE_URL=https://ORGANISATION.github.io/DEPOT
```

`SUPABASE_URL`, `SUPABASE_ANON_KEY` et `SUPABASE_SERVICE_ROLE_KEY` sont injectés
par Supabase dans l'Edge Function. La clé `service_role` ne doit être placée ni
dans GitHub Pages, ni dans `env.js`, ni dans un secret GitHub consommé par le
navigateur. Seule la fonction serveur l'utilise pour `inviteUserByEmail`.

Dans Authentication → URL Configuration, renseigner :

- **Site URL** : `https://ORGANISATION.github.io/DEPOT/` ;
- **Redirect URLs** : `https://ORGANISATION.github.io/DEPOT/**` et l'URL locale
  de développement si nécessaire (`http://localhost:8000/**`).

`PUBLIC_SITE_URL` doit rester une **URL sans fragment** : la fonction en retire
d'ailleurs tout `#…` avant de la transmettre. Supabase construit en effet le
lien de redirection en concaténant `redirectTo + "#" + jetons`. Un
`redirectTo` visant déjà une route de l'application (`…/#/administration/…`)
produirait deux fragments, et le client Supabase ne retrouverait plus aucun
jeton : l'invité arriverait sur le site sans session ni explication.

Dans Authentication → Email Templates → Invite user, conserver le lien
`{{ .ConfirmationURL }}` et expliquer que l'invité devient administrateur du
club après confirmation. Tester le modèle sur mobile et vérifier que le domaine
GitHub Pages figure dans la liste des redirections autorisées.

La page `#/administration/utilisateurs`, réservée aux super-administrateurs,
permet d'inviter, renvoyer ou révoquer une invitation et de désactiver ou
réactiver une membership. Les annuaires publics sont `#/clubs` et
`#/club/<slug>`.

### Ce que voit l'invité

1. Il reçoit l'e-mail et clique. Supabase vérifie le lien, puis redirige vers
   l'URL du site avec les jetons dans le **fragment**
   (`#access_token=…&type=invite`).
2. Le site lit ce fragment **avant** d'initialiser le client Supabase, en
   retire les jetons de la barre d'adresse et affiche l'écran bloquant
   `#/definir-mot-de-passe` : « Définir votre mot de passe ». Aucune autre vue
   n'est accessible tant qu'il n'est pas défini — ni par la navigation, ni par
   un rechargement.
3. À la validation (12 caractères minimum), le mot de passe est enregistré
   côté Supabase, puis l'invité est redirigé selon son rôle : accueil pour un
   organisateur, `#/administration/utilisateurs` pour un super-administrateur.
   Il peut dès lors se reconnecter normalement avec cet e-mail et ce mot de
   passe.
4. Un lien expiré, déjà utilisé, ou dont la session ne s'établit pas affiche
   « Lien expiré ou déjà utilisé » et invite à demander un renvoi au
   super-administrateur — jamais une page muette.

Le même écran sert aux liens de réinitialisation de mot de passe
(`type=recovery`), avec un texte d'introduction adapté.

Les invitations émises avant ce correctif portaient une URL de redirection à
deux fragments ; le site sait encore les lire, elles restent donc utilisables.

## Documentation d'exploitation

- [Architecture, déploiement Supabase et guides opérationnels](docs/OPERATIONS.md)
- [Audit de préparation pilote et risques résiduels](docs/RELEASE_AUDIT.md)

La documentation couvre le guide super-admin, le guide organisateur,
l'onboarding des clubs, la synchronisation FIDE, la checklist de publication,
le déploiement GitHub Pages et la stratégie de rollback additive.
