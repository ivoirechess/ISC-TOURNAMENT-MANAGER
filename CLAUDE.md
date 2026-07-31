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
index.html              point d'entrée
src/swiss.js            moteur d'appariement suisse — LOGIQUE PURE
src/roundrobin.js       méthode du cercle — LOGIQUE PURE
src/tiebreaks.js        départages — LOGIQUE PURE
src/tournament-*.js     règles métier (validation, édition, cycle de vie…)
src/round-entry.js      règles de saisie des résultats — LOGIQUE PURE
src/data.js             SEUL module qui parle à Supabase
src/ui/                 vues et composants
supabase/migrations/    schéma et politiques RLS, dans l'ordre d'application
supabase/tests/         vérifications RLS jouées sur un vrai Postgres
tests/                  tests unitaires et de propriété (node --test)
scripts/                outils de développement (harnais des tests RLS)
```

Pas encore écrit, malgré ce que la feuille de route appelle de ses vœux :
`scripts/fide_civ.py` (import de la liste FIDE, fédération CIV).

### Décisions déjà prises — ne pas les rouvrir sans discussion

1. **Statique d'abord.** Pas de framework, pas d'étape de compilation pour
   l'instant. On ouvre un fichier, on le modifie, il est déployé.
2. **Le moteur reste portable.** `swiss.js` et `tiebreaks.js` ne contiennent
   ni DOM, ni `fetch`, ni Supabase, ni `Date.now()`, ni `Math.random()`.
   Entrées → sorties, rien d'autre. C'est ce qui rendra une future migration
   vers SvelteKit/Astro indolore.
3. **Un seul point d'accès aux données.** Tout passe par `src/data.js`.
   Aucun autre fichier n'importe le client Supabase.
4. **Suisse, Toutes rondes et Aller-retour** sont jouables. La Coupe reste
   prévue dans l'interface mais désactivée : elle demande un modèle de
   tableau que le schéma ne décrit pas encore.

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

### Tests

`npm test` doit passer avant chaque commit. Un test qui échoue ne se contourne
pas en modifiant le test : on corrige le code, ou on justifie explicitement le
changement d'invariant.

---

## Règles métier

### Rôles

| Rôle            | Droits                                                              |
| --------------- | ------------------------------------------------------------------- |
| **super-admin** | Tout : gérer les admins, créer, saisir dans n'importe quel tournoi   |
| **admin**       | Créer un tournoi ; saisir uniquement dans **ses propres** tournois   |
| **public**      | Consultation intégrale, sans compte, en lecture seule                |

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

La FIDE fournit la **fédération**, jamais le **club** : le club se saisit à la
main. La liste officielle CIV s'importe via `scripts/fide_civ.py`.

---

## Conventions de code

- JavaScript moderne, modules ES (`import` / `export`), pas de dépendance
  au build.
- Tests avec le lanceur intégré de Node : `node --test`. Pas de framework.
- Fonctions pures partout où c'est possible ; l'état passe en argument.
- Pas de `localStorage` comme source de vérité une fois Supabase branché :
  il ne sert que de cache et de mode secours hors-ligne.

---

## Feuille de route

Une case cochée veut dire : le code est là **et** une suite le couvre. Ce qui
est écrit dans l'architecture ci-dessus mais absent du dépôt figure ici comme
non fait, pas comme acquis.

**Fait**

- [x] Moteur suisse + départages, testés
- [x] Moteur toutes rondes / aller-retour (méthode du cercle), testé
- [x] Schéma Supabase + RLS, vérifié sur un vrai Postgres (`npm run test:rls`)
- [x] Authentification et rôles
- [x] Interface tournoi : création, saisie des rondes, classement
- [x] Cycle de vie : cinq états, transitions en RPC, publication
- [x] Suppression douce + corbeille super-admin
- [x] Temps réel sur la saisie (Realtime sur `pairings`)
- [x] Intégration continue : `npm test` et `npm run test:rls` sur chaque PR

**À faire**

- [ ] Annuaire des joueurs — l'écran n'existe pas ; `src/data.js` sait déjà
      lire et créer un joueur, la table porte déjà `club`, `fide_id` et les
      trois Elo
- [ ] Import de la liste FIDE CIV — `scripts/fide_civ.py` est cité dans
      l'architecture mais n'a jamais été écrit
- [ ] Import FIDE mensuel automatisé (GitHub Actions) — dépend du précédent
- [ ] Profils et tableaux de bord (palmarès)
- [ ] Clubs comme entités : aujourd'hui `players.club` est un simple texte
      saisi à la main, sans table ni rattachement d'un tournoi à un club
- [ ] Invitations d'administrateurs : les comptes se créent encore à la main
      dans Supabase, il n'y a pas d'inscription publique (c'est voulu) ni de
      parcours d'invitation (c'est le manque)
- [ ] Exports : rien ne sort du site aujourd'hui, ni classement, ni
      appariements, ni liste de joueurs
- [ ] Audit de version : aucune trace de qui a modifié quoi ni quand, au-delà
      de `updated_at` et `last_activity_at` sur les tournois
