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
