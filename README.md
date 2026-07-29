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
2. Servir le dépôt par HTTP (les modules ES ne doivent pas être testés avec
   `file://`), par exemple `python3 -m http.server 8000`, puis ouvrir
   `http://localhost:8000/`. Sans `env.js`, le site reste consultable et le
   dialogue de connexion reste utilisable ; les opérations Supabase échouent
   avec un message explicite.

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
npm run test:e2e
npm run test:rls
```

Les tests Node couvrent la logique pure. Playwright vérifie le dialogue de
connexion dans Chromium, WebKit/iPad et un viewport mobile. Les contrôles RLS
nécessitent PostgreSQL (`initdb`, `pg_ctl`).

## Déploiement du dialogue de connexion

GitHub Pages doit publier la racine de `main`. Après fusion, remplacer la
valeur de `version.json` et de la balise `meta[name="isc-version"]` par le SHA
court déployé (une automatisation de déploiement pourra le faire), puis lancer
un smoke test sur `/ISC-TOURNAMENT-MANAGER/#/`. Dans Supabase Auth, autoriser
l'URL de production et `#/mot-de-passe` comme redirection de récupération.

La présente branche corrige la régression P0 uniquement. Les migrations de
cycle de vie, clubs, invitations, audit et FIDE décrites dans la feuille de
route produit doivent être livrées dans des lots ultérieurs et appliquées
manuellement à Supabase avant activation de leurs interfaces.
