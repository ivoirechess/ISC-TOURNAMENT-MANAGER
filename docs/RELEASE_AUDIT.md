# Audit de préparation pilote

- **RLS et permissions** : scénarios comportementaux public, propriétaires, clubs A/B, membre désactivé et super-admin dans `supabase/tests/rls_checks.sql`.
- **RPC et transactions** : création idempotente, validation, génération Suisse, clôture, réouverture et fusion exercées par les tests SQL.
- **SECURITY DEFINER / search_path** : contrôle statique automatisé par `scripts/audit-release.sh`; toutes les fonctions concernées doivent épingler leur `search_path`.
- **Migrations et index** : ordre contrôlé par `scripts/audit-release.sh`; index présents pour slugs, statuts, activité, ratings, clubs et invitations. **Écart connu** : `20260813120000_canonical_club_management.sql` et `20260813120000_player_super_admin_edit.sql` partagent le même horodatage, si bien que leur ordre d'application dépend du tri par nom de fichier — l'audit échoue sur ce point. Les deux migrations sont déjà appliquées et ne doivent pas être renommées ; la correction consiste à faire porter l'unicité par une migration ultérieure, pas à réécrire l'existant.
- **Authentification par lien e-mail** : invitation et réinitialisation passent par l'écran bloquant `#/definir-mot-de-passe`. L'URL de redirection doit rester sans fragment, sinon les jetons deviennent illisibles pour le client. Limite assumée : la porte est mémorisée par onglet (`sessionStorage`), donc un invité qui ouvre délibérément un second onglet avant d'avoir choisi son mot de passe navigue avec la session que Supabase lui a déjà accordée. Ce n'est pas une élévation de privilège — l'invitation lui donnait ce rôle — mais il ne pourra pas se reconnecter tant qu'il n'aura pas défini son mot de passe. Supabase n'expose aucun marqueur serveur permettant de distinguer cette session d'une connexion ordinaire.
- **Secrets** : `service_role` limitée aux Edge Functions; aucune clé secrète dans le client statique.
- **Erreurs réseau** : chaque écran expose un état d'erreur; Realtime indique connecté/indisponible et le bouton Actualiser reste disponible.
- **Accessibilité** : libellés des rondes, statuts `role=status`, contrôles natifs, tableaux/cartes responsives et scénarios clavier/viewport Playwright.
- **Performance** : pagination serveur des joueurs, chargement Supabase paresseux, absence de bundle lourd et rafraîchissement ciblé du tournoi. À mesurer avec des données de volume en recette.
- **Realtime** : politiques RLS identiques à la lecture directe; fallback explicite sans blocage de saisie.
- **GitHub Pages** : workflow statique dédié, HTTPS et configuration documentée; l'URL de redirection Auth doit correspondre au dépôt.

## Risques résiduels

Les E2E utilisent un double Supabase déterministe et ne remplacent pas un test sur un projet de recette. L'ouverture réelle des fichiers par une version supportée d'Excel, la délivrabilité e-mail, les volumes FIDE et la latence Realtime doivent être validés avant généralisation.
