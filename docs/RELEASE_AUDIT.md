# Audit de préparation pilote

- **RLS et permissions** : scénarios comportementaux public, propriétaires, clubs A/B, membre désactivé et super-admin dans `supabase/tests/rls_checks.sql`.
- **RPC et transactions** : création idempotente, validation, génération Suisse, clôture, réouverture et fusion exercées par les tests SQL.
- **SECURITY DEFINER / search_path** : contrôle statique automatisé par `scripts/audit-release.sh`; toutes les fonctions concernées doivent épingler leur `search_path`.
- **Migrations et index** : ordre/identifiants uniques contrôlés; index présents pour slugs, statuts, activité, ratings, clubs et invitations.
- **Secrets** : `service_role` limitée aux Edge Functions; aucune clé secrète dans le client statique.
- **Erreurs réseau** : chaque écran expose un état d'erreur; Realtime indique connecté/indisponible et le bouton Actualiser reste disponible.
- **Accessibilité** : libellés des rondes, statuts `role=status`, contrôles natifs, tableaux/cartes responsives et scénarios clavier/viewport Playwright.
- **Performance** : pagination serveur des joueurs, chargement Supabase paresseux, absence de bundle lourd et rafraîchissement ciblé du tournoi. À mesurer avec des données de volume en recette.
- **Realtime** : politiques RLS identiques à la lecture directe; fallback explicite sans blocage de saisie.
- **GitHub Pages** : workflow statique dédié, HTTPS et configuration documentée; l'URL de redirection Auth doit correspondre au dépôt.

## Risques résiduels

Les E2E utilisent un double Supabase déterministe et ne remplacent pas un test sur un projet de recette. L'ouverture réelle des fichiers par une version supportée d'Excel, la délivrabilité e-mail, les volumes FIDE et la latence Realtime doivent être validés avant généralisation.
