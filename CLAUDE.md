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
index.html            point d'entrée
src/swiss.js          moteur d'appariement — LOGIQUE PURE
src/tiebreaks.js      départages — LOGIQUE PURE
src/data.js           SEUL module qui parle à Supabase
src/ui/               vues et composants
tests/                tests unitaires et de propriété (node --test)
scripts/fide_civ.py   import de la liste FIDE (fédération CIV)
```

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

Ordre d'application, du premier au dernier :

1. Points
2. Buchholz
3. Buchholz tronqué-1 (retire le plus faible adversaire)
4. Sonneborn-Berger
5. Cumulatif (progressif)
6. Nombre de victoires
7. Ordre alphabétique (départage final, déterministe)

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

- [x] Moteur suisse + départages, testés
- [x] Moteur toutes rondes / aller-retour (méthode du cercle), testé
- [x] Schéma Supabase + RLS
- [x] Authentification et rôles
- [ ] Interface tournoi : [x] création, [ ] saisie des rondes, [ ] classement
- [ ] Annuaire des joueurs + import FIDE
- [ ] Profils et tableaux de bord (palmarès)
- [ ] Import FIDE mensuel automatisé (GitHub Actions)
