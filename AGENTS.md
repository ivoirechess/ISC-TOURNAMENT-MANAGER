# ISC Tournament Manager — consignes Codex

- Le front-end reste statique pendant cette phase : JavaScript ES modules, sans framework ni build complexe sans justification.
- `src/data.js` est le seul module front-end autorisé à communiquer avec Supabase.
- Les moteurs d'appariement et de départage restent purs, sans DOM, réseau, horloge ou état global.
- Ne jamais exposer de clé `service_role`, secret key, mot de passe ou jeton dans le navigateur, le dépôt, `env.js`, les logs, issues ou PR.
- Toute migration touchant le RLS doit être validée avec `npm run test:rls`; `npm test` doit toujours rester vert.
- Les opérations métier importantes portant sur plusieurs tables sont transactionnelles côté PostgreSQL, jamais compensées uniquement dans le navigateur.
- Rendre toute donnée utilisateur avec `textContent` ou des nœuds DOM sûrs, jamais en l'injectant dans `innerHTML`.

