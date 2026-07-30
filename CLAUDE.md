# ISC Tournament Manager

Plateforme de gestion de tournois d'échecs pour la Côte d'Ivoire (Ivoire Chess).
Inspirée de chess-results : annuaire public de tournois, saisie réservée aux
organisateurs, archives consultables durablement.

**Langue de l'interface : français.** Tous les textes visibles par l'utilisateur
sont en français. Le code (variables, fonctions, commentaires) est en anglais.

---

## Architecture

Front-end statique hébergé sur GitHub Pages + Supabase (Postgres, Auth, RLS,
Realtime) comme back-end.

```
index.html               point d'entrée
src/swiss.js             moteur d'appariement suisse — LOGIQUE PURE
src/roundrobin.js        méthode du cercle — LOGIQUE PURE
src/tiebreaks.js         départages — LOGIQUE PURE
src/auth-callback.js     liens d'invitation et de réinitialisation — LOGIQUE PURE
src/data.js              SEUL module qui parle à Supabase
src/ui/                  vues et composants
supabase/migrations/     schéma, RLS, RPC (additif, jamais réécrit)
supabase/functions/      Edge Functions Deno (service_role côté serveur seul)
supabase/tests/          vérifications RLS jouées par npm run test:rls
tests/                   tests unitaires et de propriété (node --test)
e2e/                     scénarios Playwright + double Supabase déterministe
scripts/fide_civ.py      import de la liste FIDE (fédération CIV)
scripts/audit-release.sh contrôle statique SECURITY DEFINER / search_path
docs/                    exploitation et audit de préparation pilote
```

Les autres modules purs suivent le même standard : `tournament-validation.js`,
`tournament-lifecycle.js`, `tournament-edit.js`, `tournament-delete.js`,
`tournament-exports.js`, `tournament-list.js`, `tournament-page.js`,
`round-entry.js`, `player-directory.js`, `player-merge.js`,
`club-administration.js`, `roles.js`, `config.js`.

### Décisions déjà prises — ne pas les rouvrir sans discussion

1. **Statique d'abord.** Pas de framework, pas d'étape de compilation pour
   l'instant. On ouvre un fichier, on le modifie, il est déployé.
2. **Le moteur reste portable.** `swiss.js` et `tiebreaks.js` ne contiennent
   ni DOM, ni `fetch`, ni Supabase, ni `Date.now()`, ni `Math.random()`.
   Entrées → sorties, rien d'autre. C'est ce qui rendra une future migration
   vers SvelteKit/Astro indolore.
3. **Un seul point d'accès aux données.** Tout passe par `src/data.js`.
   Aucun autre fichier du front-end n'importe le client Supabase. Les Edge
   Functions de `supabase/functions/` sont du code serveur : elles ont leur
   propre client, et sont réservées aux opérations Auth qui exigent la clé
   `service_role`.
4. **Suisse, Toutes rondes et Aller-retour** sont jouables. La Coupe reste
   prévue dans l'interface mais désactivée : elle demande un modèle de
   tableau que le schéma ne décrit pas encore.
5. **Les invariants vivent dans PostgreSQL.** Les règles qu'une politique RLS
   ne sait pas exprimer (nombre de rondes gelé après le démarrage,
   appariement jamais déplacé, transitions d'état) sont portées par des
   triggers et des fonctions transactionnelles, pas par l'interface. Nos
   triggers lèvent le SQLSTATE `ISC01` avec un message français destiné à
   être lu tel quel.

---

## Règles absolues

### Secrets

- La clé **anon** de Supabase est publique par conception : elle peut figurer
  dans le code. C'est le RLS qui protège les données, pas le secret de la clé.
- La clé **service_role** ne doit **jamais** apparaître : ni dans le dépôt, ni
  dans le front-end, ni dans une variable d'environnement de session cloud,
  ni dans une issue ou une PR. Aucune exception.
- Avant tout commit : vérifier qu'aucun token, mot de passe ou clé privée
  n'est ajouté.

### Sécurité des accès

Le contrôle « qui peut écrire » est appliqué **côté serveur** par les règles
RLS de Supabase. Une vérification côté navigateur est un confort d'interface,
jamais une protection. Toute modification touchant aux politiques RLS doit
être relue explicitement avant fusion.

### Migrations

Une migration appliquée ne se modifie ni ne se supprime **jamais** : toute
correction est une nouvelle migration additive, horodatée après les
précédentes. Le rollback applicatif consiste à redéployer le commit GitHub
Pages précédent, jamais à rejouer une migration. Détail dans
[`docs/OPERATIONS.md`](docs/OPERATIONS.md).

### Tests

Trois suites, toutes attendues au vert avant fusion :

| Commande            | Portée                                                     |
| ------------------- | ---------------------------------------------------------- |
| `npm test`          | unitaires et de propriété, `node --test`, sans dépendance   |
| `npm run test:rls`  | migrations + politiques RLS sur un PostgreSQL jetable       |
| `npm run test:e2e`  | Playwright sur le double Supabase de `e2e/mock-supabase.js` |

`scripts/audit-release.sh` complète la panoplie avant une mise en production.

`npm test` doit passer avant chaque commit. Un test qui échoue ne se contourne
pas en modifiant le test : on corrige le code, ou on justifie explicitement le
changement d'invariant.

Le double Supabase de `e2e/` doit rester **fidèle au vrai client** : il
reproduit le comportement documenté de `@supabase/supabase-js` (flux
implicite, `detectSessionInUrl`, lecture du fragment d'URL). Un double
complaisant ferait passer des tests sur un bug réel.

---

## Règles métier

### Rôles

| Rôle            | Droits                                                              |
| --------------- | ------------------------------------------------------------------- |
| **super-admin** | Tout : gérer les admins, créer, saisir dans n'importe quel tournoi   |
| **admin**       | Créer un tournoi ; saisir dans **ses** tournois et ceux de son club  |
| **public**      | Consultation intégrale, sans compte, en lecture seule                |

Le rôle est lu dans `profiles.role`, jamais déduit de la simple présence
d'une session. Un admin peut en outre appartenir à un ou plusieurs clubs
(`club_memberships`, rôle `owner` ou `admin`) : les tournois portant le
`club_id` correspondant lui sont ouverts tant que sa membership est active.
Une membership désactivée ne donne aucun droit d'écriture, et un admin sans
membership conserve ses anciens tournois personnels.

### Comptes et invitations

Il n'y a **aucune inscription publique** : le site n'expose ni formulaire de
création de compte, ni lien d'inscription, et l'option correspondante est
désactivée côté Supabase.

Un super-admin invite un organisateur depuis `#/administration/utilisateurs`.
L'invitation part de l'Edge Function `invite-admin`, seule détentrice de la
clé `service_role`, qui crée l'invitation auditée, le profil `admin` et la
membership du club, puis appelle `inviteUserByEmail`.

L'invité reçoit un lien e-mail. Supabase utilise le **flux implicite** : les
jetons arrivent dans le **fragment** de l'URL de redirection
(`#access_token=…&type=invite`), jamais dans la requête. Deux conséquences
qui ne s'improvisent pas :

- L'URL de redirection ne doit contenir **aucun fragment**. Supabase
  construit littéralement `redirectTo + "#" + paramètres` : une redirection
  vers `…/#/une/route` produirait deux fragments et le client ne verrait
  plus les jetons.
- Le marqueur `type=invite` (ou `type=recovery`) n'existe **que** dans
  l'URL, à l'instant du clic. La session qui en découle ne s'en distingue
  ensuite plus d'une connexion ordinaire.

`src/auth-callback.js` lit donc ce fragment avant toute initialisation du
client Supabase, en accepte aussi la forme héritée à deux fragments, et
retire les jetons de l'URL. L'écran `#/definir-mot-de-passe` est alors
**bloquant** : tant que le mot de passe n'est pas défini, aucune autre vue
n'est accessible. Un lien expiré ou déjà utilisé affiche un message explicite
invitant à demander un renvoi au super-admin.

Cet écran est un garde-fou d'interface, comme tout le reste côté navigateur :
la session d'invitation est une vraie session émise par Supabase, et c'est le
RLS qui décide de ce qu'elle peut écrire.

### Cycle de vie d'un tournoi

`brouillon → publié → en cours → clôturé`, plus `annulé` à tout moment avant
la clôture. Chaque transition est une fonction PostgreSQL (`publish_`,
`unpublish_`, `start_`, `finish_`, `cancel_`, `reopen_tournament`) et non un
`UPDATE` : plusieurs doivent vérifier l'état et écrire de façon atomique, et
la dépublication doit masquer la ligne à son propre auteur — ce qu'un
`UPDATE` sous RLS ne peut pas faire.

Les rondes suivent le même principe : `validate_round` clôt une ronde
complète et libère la suivante dans la même transaction ; `reopen_round` est
une opération exceptionnelle de super-admin, journalisée.

Une suppression n'efface rien : elle marque `deleted_at`
(`soft_delete_tournament`). Seul un super-admin voit la corbeille
`#/corbeille`, restaure, ou supprime définitivement. Réouvertures et
suppressions sont consignées dans des journaux append-only.

### Exports

`src/tournament-exports.js`, module pur : liste de départ, appariements,
classement et feuilles de résultats. Les exports tabulaires sont lisibles par
un tableur, les feuilles de résultats sont faites pour l'affichage en salle.
Aucun export ne contient de donnée privée — ni e-mail de compte, ni
identifiant technique de session.

### Nombre de rondes (garde-fou)

Ce garde-fou ne concerne que le **suisse**. Pour `n` joueurs inscrits :

- **Maximum** : `n - 2` si `n` est pair, `n - 1` si `n` est impair. Au-delà,
  le suisse dégénère en round-robin et l'appariement par score voisin tombe
  structurellement en impasse → la création est **bloquée**, avec un message
  orientant vers le format **Toutes rondes** — c'est ce que l'utilisateur
  demande réellement à ce niveau de rondes.
- **Recommandé** : au moins `ceil(log2(n))` rondes pour dégager un vainqueur
  net. En dessous → simple **avertissement**, pas un blocage.

En **Toutes rondes** et **Aller-retour**, rien ne se choisit : le calendrier
joue toutes les rencontres, donc le nombre de rondes découle de l'effectif
(`n - 1` si `n` est pair, `n` sinon ; doublé à l'aller-retour). L'interface
le calcule et verrouille le champ.

### Appariement toutes rondes (méthode du cercle)

`src/roundrobin.js`, même standard de pureté que `src/swiss.js`. Un siège
reste fixe, les autres tournent d'un cran par ronde ; un joueur fictif
complète les effectifs impairs et son adversaire est exempt.

Ce moteur **ne connaît pas de mode dégradé**, et n'en a pas besoin : le
calendrier entier se déduit du seul effectif, avant le premier coup joué et
indépendamment des résultats. Aucune impasse ne peut donc survenir — c'est
une propriété de construction, vérifiée par les tests plutôt qu'affirmée.
C'est aussi pourquoi ce format est la réponse au blocage du suisse.

Attention : l'invariant « un seul bye par tournoi » ci-dessous appartient au
**suisse**. Ici, à effectif impair, chaque joueur est exempt une fois par
tour — donc **deux fois en aller-retour**. C'est l'usage normal et sans
effet sur le classement, chacun recevant le même point supplémentaire.

Le calendrier étant entièrement déterminé, il est généré et enregistré
**dès la création** du tournoi (`rounds` + `pairings`), contrairement au
suisse dont chaque ronde dépend des résultats de la précédente.

### Appariement suisse

Invariants que le moteur doit garantir :

1. Chaque joueur actif apparaît exactement une fois par ronde (apparié ou exempt).
2. Deux joueurs ne se rencontrent jamais deux fois.
3. Un joueur ne reçoit **qu'un seul** bye sur tout le tournoi.
4. Un bye n'existe que si le nombre de joueurs actifs est impair. Il vaut 1 point.
5. Écart de couleurs par joueur : `|blancs - noirs| <= 2`.
6. Les joueurs sont appariés par score voisin (on minimise l'écart de points).

C'est un suisse **simplifié**, adapté à un club. Ce n'est pas le système Dutch
homologué FIDE. Si des tournois homologués deviennent nécessaires, on intégrera
un moteur dédié (bbpPairings) plutôt que de complexifier celui-ci.

#### Limites assumées — mode dégradé

`pairRound` ne lève **jamais** d'erreur pour un simple défaut d'appariement
parfait : en club, on ne peut pas annoncer à dix joueurs qu'un théorème
interdit la ronde suivante. Elle renvoie toujours `{ pairings, warnings }` :

- En temps normal, `warnings` est vide et les six invariants tiennent.
- Quand aucun appariement sans revanche n'existe, elle renvoie le **moins
  mauvais** — en minimisant le nombre de revanches, sans jamais sacrifier
  l'équilibre des couleurs — et décrit chaque revanche forcée dans
  `warnings`. L'interface les affiche à l'arbitre pour confirmation. Une
  dégradation visible et assumée vaut mieux qu'un blocage.

La contrainte « score voisin » consomme de la marge d'appariement de façon
dépendante de la **dynamique du tournoi** (scores et couleurs déjà joués),
pas seulement de `n` : aucune formule statique sur `n` ne peut garantir zéro
revanche à la dernière ronde pour un petit effectif. Conséquence, mesurée et
acceptée : pour `n <= 8` poussé jusqu'au plafond de rondes, une revanche
forcée en **toute dernière ronde** est une dégradation connue, affichée à
l'arbitre — pas une erreur du moteur. Un `warning` avant la dernière ronde,
ou pour `n > 8`, est en revanche un vrai bug (les tests l'imposent).

Les invariants 1, 3, 4 et 6 (présence unique, bye unique, bye ssi effectif
impair, somme des points) ne sont **jamais** dégradés. L'invariant 5
(couleurs) non plus. Seul l'invariant 2 (pas de revanche) peut céder, et
uniquement s'il est déclaré dans `warnings`.

### Départages

`src/tiebreaks.js`, module pur. Les définitions suivent les règles FIDE,
y compris l'**adversaire virtuel** pour les parties non jouées :
`Svon = SPR + (1 − SfPR) + 0,5 × (n − R)`. Un bye valant 1 point ici, cela
revient au score du joueur avant la ronde, plus une demi-ponte par ronde
restante.

L'ordre n'est **pas figé** : chaque tournoi enregistre le sien à la création
(colonne `tournaments.tiebreaks`, de 2 à 6 critères). Deux positions sont
imposées et ne sont donc jamais stockées :

- **Points** — toujours le premier critère.
- **Ordre alphabétique** — toujours le dernier filet, non sélectionnable.
  Il garantit un classement déterministe même quand tous les départages
  choisis laissent des joueurs à égalité.

Entre les deux, au choix de l'organisateur : Buchholz, Buchholz tronqué-1,
Sonneborn-Berger, Cumulatif, Nombre de victoires, Confrontation directe.

**Confrontation directe** — ne s'applique à un groupe d'ex æquo que si
**toutes** les paires du groupe se sont rencontrées ; sinon elle est ignorée
pour ce groupe et le départage suivant prend le relais. Une paire qui s'est
rencontrée plusieurs fois (aller-retour) compte pour la **moyenne** de ces
rencontres, jamais leur somme.

### Joueurs

Entités **permanentes**, indépendantes des tournois. Un tournoi référence des
joueurs par leur identifiant, il ne les recopie pas.

Aucun champ n'est obligatoire hormis le nom. Champs optionnels : ID FIDE, club,
sexe, année de naissance, Elo standard / rapide / blitz.

La FIDE fournit la **fédération**, jamais le **club**. Le club est une entité
locale **canonique** (`clubs`, référencée par `players.club_id`) et non plus
un texte libre : la création d'un joueur passe par `create_player_with_club` /
`resolve_or_create_club`, qui rapprochent les anciennes valeurs texte. Les
champs synchronisés depuis la liste officielle sont protégés par un trigger ;
`club`, `club_id` et `local_notes` restent locaux et ne sont jamais écrasés
par un import.

La liste officielle CIV s'importe via `scripts/fide_civ.py` (TXT, XML ou ZIP,
filtre `FED = CIV`), exécuté chaque mois par
`.github/workflows/fide-civ.yml`, qui publie un rapport et son empreinte
SHA-256. `--apply` exige `DATABASE_URL` et n'écrit que les champs FIDE.

Les doublons se traitent par `find_player_duplicates` puis `merge_players`
(super-admin, raison obligatoire) : la fusion déplace inscriptions et
appariements dans une transaction unique, marque la source comme fusionnée et
refuse toute fusion qui créerait deux apparitions dans la même ronde. Les
fiches fusionnées redirigent vers la fiche cible.

---

## Conventions de code

- JavaScript moderne, modules ES (`import` / `export`), pas de dépendance
  au build.
- Tests avec le lanceur intégré de Node : `node --test`. Pas de framework.
- Fonctions pures partout où c'est possible ; l'état passe en argument.
- Pas de `localStorage` comme source de vérité une fois Supabase branché :
  il ne sert que de cache et de mode secours hors-ligne.
- Les messages d'erreur affichés sont écrits pour l'organisateur, pas pour la
  console : un refus RLS se traduit par une phrase française, jamais par un
  nom de relation ou de contrainte.
- Un flux d'authentification ne journalise jamais un mot de passe, ni un
  jeton, ni un fragment d'URL qui en contient — y compris dans les messages
  d'erreur.

---

## Documentation

- [`README.md`](README.md) — configuration locale, réglages Supabase requis,
  déploiement de l'Edge Function, flux d'invitation.
- [`docs/OPERATIONS.md`](docs/OPERATIONS.md) — architecture, déploiement,
  guides super-admin et organisateur, checklist de publication, rollback.
- [`docs/RELEASE_AUDIT.md`](docs/RELEASE_AUDIT.md) — audit de préparation
  pilote et risques résiduels.

---

## Feuille de route

- [x] Moteur suisse + départages, testés
- [x] Moteur toutes rondes / aller-retour (méthode du cercle), testé
- [x] Schéma Supabase + RLS, vérifiés par `npm run test:rls`
- [x] Authentification et rôles
- [x] Interface tournoi : création, saisie des rondes, validation, classement
- [x] Cycle de vie complet : publication, démarrage, clôture, annulation,
      réouverture, corbeille et suppression définitive
- [x] Création transactionnelle idempotente (`create_tournament_with_players`)
- [x] Annuaire des joueurs, fiches publiques, alias et fusion super-admin
- [x] Import FIDE mensuel automatisé (GitHub Actions + `scripts/fide_civ.py`)
- [x] Clubs canoniques, annuaires `#/clubs` et `#/club/<slug>`
- [x] Invitations administrateurs (Edge Function `invite-admin`, audit,
      renvoi, révocation, désactivation de membership)
- [x] Écran bloquant « Définir votre mot de passe » à l'arrivée d'une
      invitation ou d'une réinitialisation
- [x] Exports Excel et feuilles de résultats
- [x] Audit de préparation pilote (`docs/RELEASE_AUDIT.md`,
      `scripts/audit-release.sh`) et guides d'exploitation
- [ ] Profils et tableaux de bord (palmarès)
- [ ] Format Coupe (tableau à élimination) — encore absent du schéma
- [ ] Validation sur un projet Supabase de recette : délivrabilité e-mail,
      volumes FIDE réels, latence Realtime, ouverture des exports dans Excel
