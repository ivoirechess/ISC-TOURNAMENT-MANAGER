# Exploitation ISC Tournament Manager

## Architecture

L'application est un site statique ES modules (`index.html`, `src/ui`) sans serveur applicatif. `src/data.js` est l'unique adaptateur Supabase. La logique métier pure réside dans `src/*.js`; PostgreSQL porte les invariants transactionnels, RLS et RPC. Realtime ne diffuse que des lignes déjà lisibles par RLS. Les Edge Functions sont réservées aux opérations Auth nécessitant la `service_role`.

## Déploiement Supabase

1. Créer un projet de recette et désactiver les inscriptions publiques.
2. Exécuter les migrations dans leur ordre horodaté avec `supabase db push`. Ne jamais renommer une migration déjà appliquée, même pour corriger un horodatage en double (voir `docs/RELEASE_AUDIT.md`).
3. Exécuter `npm run test:rls` contre la pile locale.
4. Déployer `invite-admin`, configurer `PUBLIC_SITE_URL` et les Redirect URLs.
5. Activer Realtime pour `pairings`; vérifier l'état « Realtime connecté » sur une page tournoi.
6. Configurer le cron FIDE et `SUPABASE_DB_URL` uniquement dans GitHub Actions.
7. Promouvoir en production après export/sauvegarde de la base de recette.

## Guide super-admin

- Créer les clubs et vérifier leurs slugs avant toute invitation.
- Inviter depuis `#/administration/utilisateurs`; contrôler club et e-mail.
- Renvoyer uniquement une invitation en attente, révoquer une invitation erronée.
- Désactiver immédiatement un administrateur sortant; réactiver seulement après validation du club.
- Utiliser `merge_players` avec une raison explicite et une sauvegarde préalable.
- Contrôler le journal `admin_invitation_events` après toute opération sensible.

## Guide organisateur

1. Vérifier les joueurs, cadence, départages et nombre de rondes.
2. Créer et relire le brouillon, puis publier.
3. Démarrer; saisir tous les résultats; filtrer les parties sans résultat.
4. Exporter appariements et feuilles de résultats avant affichage en salle.
5. Valider la ronde seulement après contrôle; exporter le classement publié.
6. En Suisse, générer la ronde suivante; en Toutes rondes, vérifier son déblocage.
7. Clôturer uniquement après validation de la dernière ronde.

## Onboarding d'un club

Créer le club actif avec contacts publics, inviter l'owner, vérifier la confirmation, puis effectuer un tournoi brouillon de recette. Tester qu'un administrateur du club ne peut ni voir les invitations ni modifier le tournoi d'un autre club. Désactiver le compte de recette à la fin.

## Synchronisation FIDE

Le workflow mensuel appelle `scripts/fide_civ.py`, filtre `FED=CIV`, conserve UTF-8, produit un checksum et n'écrase jamais club/notes locales. Examiner le nombre de lignes et le checksum avant application. En cas d'écart inhabituel, relancer avec `--dry-run` et conserver l'artefact précédent.

## Checklist de publication

- [ ] `npm test`, `npm run test:rls`, `npm run test:e2e`, `scripts/audit-release.sh` verts.
- [ ] Sauvegarde Supabase et migrations appliquées en recette.
- [ ] RLS public/admin A/admin B/désactivé/super-admin vérifié.
- [ ] Invitation, e-mail, Redirect URL et révocation vérifiés.
- [ ] Lien d'invitation suivi de bout en bout : écran « Définir votre mot de passe », reconnexion avec ce mot de passe, lien expiré expliqué.
- [ ] Realtime connecté et bouton Actualiser opérationnel en fallback.
- [ ] Exports ouverts dans Excel et feuilles imprimées sans donnée privée.
- [ ] Navigation clavier, mobile Chromium et iPad WebKit contrôlés.
- [ ] Domaine GitHub Pages, HTTPS, `env.js` public et cache contrôlés.

## Rollback

Ne jamais modifier ou supprimer une migration appliquée. Pour un défaut applicatif, redéployer le commit GitHub Pages précédent. Pour un défaut SQL, couper les écritures, sauvegarder, puis créer une **nouvelle migration corrective**; restaurer la sauvegarde uniquement si la correction additive est impossible. Révoquer/désactiver les invitations concernées. Pour FIDE, restaurer les champs synchronisés depuis l'artefact mensuel précédent sans toucher aux champs locaux. Documenter l'incident, les identifiants affectés et les commandes exécutées.
