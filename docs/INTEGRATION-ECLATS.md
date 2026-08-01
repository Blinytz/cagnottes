# Cagnottes : euros, Bourse et Éclats

Cagnottes compte en **euros** (en centimes entiers). Les Éclats restent la
monnaie de l'écosystème : ils n'entrent dans Cagnottes que par une
**conversion explicite**, à la parité fixe **100 ✦ = 1 €**.

```
Éclats communs ◀──(100 ✦ = 1 €)──▶ Bourse (€) ──▶ Cagnottes (€)
   Pronos, Discipline…              réversible        versements locaux
```

La Bourse est un **intermédiaire volontaire** : on y convertit au fil de l'eau,
puis on répartit dans les cagnottes. Verser ne parle donc jamais au réseau —
seule la conversion le fait. Et ce qu'on n'a pas versé peut repartir en Éclats.

La parité étant fixe, **1 Éclat = 1 centime** : il n'y a aucun calcul de
conversion, seulement un changement d'unité. Une cagnotte « Téléphone à 600 € »
reste parlante là où « 60 000 ✦ » ne l'était pas.

## Ce qui est livré

| Fichier | Rôle |
|---|---|
| `js/bourse.js` | La Bourse : conversion Éclats → euros, reprise euros → Éclats, journal des conversions. Porte la parité. |
| `js/eclats-local.js` | Journal local générique (clé paramétrable) — sert de Bourse. |
| `js/eclats-cagnottes.js` | Journal des versements, branché sur la Bourse. |
| `js/eclats-registre.js` | Client du registre commun (Supabase), pour les conversions. |
| `js/bascule-euros.js` | Passage v2 (Éclats) → v3 (euros), fonctions pures. |
| `js/main.js` | Assemblage. **Seul endroit qui décide d'où vient l'argent.** |
| `tests/` | 45 tests (`node --test "tests/*.test.mjs"`). |

## Règles d'une conversion

- Elle **dépense réellement des Éclats** (`eclats_spend`, confirmée par le serveur).
- **Tu choisis le montant** : une part de tes Éclats, pas forcément tout.
- Les euros crédités portent sur les Éclats **réellement dépensés** (le registre
  plafonne au solde disponible).
- Elle est **idempotente** : double clic, rejeu ou rechargement ne convertissent
  jamais deux fois.

## Rendre des euros : tout ou partie du solde

**Seule la Bourse est reprenable.** Ce qui est déjà versé dans une cagnotte ne
l'est pas : il faut d'abord l'en sortir — annuler un versement, ou supprimer la
cagnotte, ce qui rend automatiquement ses euros à la Bourse. Le montant
demandé est donc plafonné au solde disponible, et à lui seul.

Dans cette limite, **le montant est libre** : on rend 20 € sur 50, ou tout.

### Pourquoi ce n'est pas trivial

Le registre commun ne sait pas créditer des Éclats, seulement **rembourser une
dépense passée**, et **en entier** (`eclats_refund`). C'est la garantie qui rend
structurellement impossible qu'une application fabrique des Éclats.

Pour rendre 20 € alors que la seule conversion passée en valait 50, la Bourse
rembourse donc la conversion entière (+5 000 ✦) puis **reconvertit aussitôt le
reliquat** (−3 000 ✦). Net : 2 000 ✦ rendus, 30 € conservés. Ce réancrage est
interne — l'utilisateur demande simplement un montant.

Invariant maintenu à chaque étape :

```
solde de la Bourse = Σ(conversions actives) − Σ(engagé en cagnottes)
```

### Les conversions faites avant la parité fixe

Pendant quelques jours, le taux a flotté entre 0,60 et 1,40. Les conversions de
cette période ont dépensé un nombre d'Éclats **différent** des euros crédités,
et elles sont toujours dans le journal.

Or un remboursement rend les Éclats *réellement dépensés*. Sans précaution,
rendre les 6,00 € issus d'une conversion à 0,60 rapporterait les 1 000 ✦
dépensés — 400 Éclats créés à partir de rien.

La sélection des conversions à défaire suit donc **deux cumuls** : les euros
qu'elles ont crédités et les Éclats qu'elles ont dépensés. Il faut assez des
deux, et le plafond reprenable devient `min(solde, Éclats adossés)`. Une
conversion passée à un taux > 1,00 laisse ainsi des euros acquis mais non
adossés : ils restent dépensables dans les cagnottes, mais ne peuvent plus
repartir en Éclats.

### Ordre des opérations

Délibéré : les euros quittent la Bourse **en premier** (local, sûr), avant tout
échange avec le registre. Toute interruption laisse donc l'utilisateur avec
moins que son dû — jamais avec plus, ce qui reviendrait à créer de la valeur.

Chaque étape est idempotente et note son avancement : rejouer ne refait que ce
qui manque. Une reprise inachevée est signalée dans **À confirmer**, et
**terminée automatiquement au démarrage** de l'application — elle ne peut que
se réparer vers le haut.

## La bascule vers les euros

Détectée au démarrage si l'état est en version 2. Elle **rembourse d'abord au
registre commun tous les versements faits en Éclats**, puis réétiquette l'état.
Rien n'est réécrit tant que les remboursements ne sont pas confirmés : mieux vaut
une bascule reportée que des Éclats perdus. Une copie de l'état « tout en Éclats »
est conservée dans `cagnottes_sauvegarde_eclats_v2`.

Les cagnottes gardent nom, image, objectif, palier et ordre ; elles repartent
vides. La Bourse démarre à 0 € : c'est à toi de convertir.

> Les objectifs gardent leur valeur numérique — 60 000 ✦ *sont* 600,00 €.
> Aucun arrondi, aucune perte.

## Dans l'interface

- Le bandeau haut affiche les deux monnaies, jamais confondues : les **Éclats**
  du registre commun à gauche, la **Bourse en euros** à droite.
- L'onglet **Change** montre la Bourse, tes Éclats disponibles et leur équivalent,
  le champ de conversion et celui de reprise (tous deux avec aperçu en direct et
  bouton « Tout »), et l'historique des échanges dans les deux sens.
- Verser dans une cagnotte puise dans la **Bourse** : aucune dépendance au réseau
  pour l'usage quotidien.
- Le « − » annule le dernier versement encore engagé, pour son montant exact.

## Garde-fous

- Aucune clé `service_role` dans le navigateur.
- Les euros sont des **centimes entiers** : pas de dérive de flottant.
- Le montant d'une cagnotte est dérivé de ses versements, jamais recopié.
- Une opération non confirmée n'est **jamais** présentée comme comptabilisée.
- L'export embarque les **deux** journaux de la Bourse (les euros et les
  conversions qui les ont produits) ; l'import les restaure **ensemble**. Séparés,
  ils décriraient un solde sans origine.
