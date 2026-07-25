# Intégration de Cagnottes au registre commun d'Éclats

Cagnottes ne compte plus qu'en **Éclats**, cagnottes comprises. La « Bourse »
locale a été supprimée : l'application ne crée jamais d'Éclats, elle en dépense
et en rend. Le solde vient d'un **registre** — local aujourd'hui, le registre
commun de l'écosystème (même projet Supabase que Pronos) dès que la migration
sera exécutée.

## Ce qui est livré et branché

| Fichier | Rôle |
|---|---|
| `js/eclats-registre.js` | Client du registre commun (auth mot de passe, RPC `eclats_balance` / `eclats_spend` / `eclats_refund` / `eclats_aggregates_by_app`). **Clé publishable uniquement**, aucun secret. |
| `js/eclats-local.js` | Registre **local** au contrat identique, utilisé en attendant la bascule. Reproduit la sémantique SQL : plafond au solde, idempotence par clé, remboursement exactement-une-fois. |
| `js/eclats-cagnottes.js` | Journal des versements : versement = dépense confirmée serveur ; annulation = remboursement exactement-une-fois ; états `en_attente` / `confirme` / `refuse` / `erreur` ; garde double-clic. |
| `js/eclats-migration.js` | Bascule euro → Éclats (fonctions pures, sans effet de bord). |
| `js/main.js` | Assemblage. **Seul endroit qui décide d'où vient le solde.** |
| `tests/` | 34 tests (`node --test "tests/*.test.mjs"`) : contrôleur, équivalence du registre local avec le SQL, bascule. |

## La bascule vers le registre commun

Une ligne dans `js/main.js` :

```js
import { createRegistre } from './eclats-registre.js';
const registre = createRegistre();   // au lieu de createRegistreLocal()
```

Ni le Store ni l'interface ne changent : les deux registres exposent le même
contrat, et `tests/eclats-local.test.mjs` verrouille cette équivalence. Ce qui
reste à faire côté produit :

1. **Exécuter la migration** `apps/pronos/sql/registre_commun.sql` (voir
   `registre_commun_backup / _verification / _rollback`). L'UI connectée **ne
   doit pas** être publiée avant.
2. **Ajouter un écran de connexion** Supabase (même compte que Pronos), en
   réutilisant `eclats-registre.js`.
3. **Reprendre le solde d'ouverture** : les 100 ✦ de départ ont été fixés
   arbitrairement et devront être corrigés lors de la synchronisation avec
   Centrale.
4. **Décider du sort du journal local** : les mouvements tenus localement ne
   sont pas transférés automatiquement dans le registre commun.

Tant que la bascule n'est pas faite, l'écran Éclats affiche explicitement
« Registre local », pour qu'aucun solde ne soit présenté comme partagé alors
qu'il ne l'est pas.

## Conversion des données euro (décision du 25/07/2026)

Taux fixe **1 € = 100 ✦**, appliqué **une seule fois** à la première ouverture.
Le taux rend tous les montants entiers sans perte, l'Éclat étant indivisible :
0,50 € → 50 ✦, 60 € → 6 000 ✦.

> Cette conversion **remplace** la règle « aucune conversion euro→Éclat
> automatique » posée initialement dans `contracts/REGISTRE-PARTAGE.md`. Elle
> est unique, explicite, et laisse derrière elle une copie intégrale des
> données d'origine (`cagnottes_sauvegarde_euro_v1`, exportable depuis les
> Réglages).

L'historique n'est pas recopié mais **rejoué** en versements : un apport devient
un versement confirmé daté, un retrait annule les versements les plus récents
(LIFO) en re-versant le reliquat quand il ne consomme qu'une partie du dernier.
Le journal reconstruit obéit donc exactement aux règles retenues pour l'avenir,
avec les mêmes dates et les mêmes montants (×100). Le solde de chaque cagnotte
est ensuite recalé sur le montant réellement affiché avant la bascule : c'est
lui qui fait foi pour l'utilisateur, même si l'historique était incomplet.

L'ancien solde de Bourse n'est **pas** reporté : il est remplacé par le solde
d'ouverture. Le mouvement d'ouverture couvre ce solde **plus** tout ce qui est
déjà engagé dans les cagnottes, faute de quoi le journal rejoué décrirait des
dépenses sans provision.

## Modèle appliqué dans l'UI

- Le bandeau haut affiche le **solde disponible** et le **total engagé**.
- L'écran **Éclats** (qui remplace l'onglet Bourse) montre disponible, engagé,
  déjà récompensé, et la **répartition par application** — la même lecture que
  Centrale, via `eclats_aggregates_by_app`.
- « Verser » appelle `ec.verser()` : succès → montant réellement versé (peut
  être plafonné) ; `solde_insuffisant` → message clair, rien n'est
  comptabilisé ; `reseau` → état « erreur », bouton **Réessayer** sur l'écran
  Éclats (`ec.reprendre`, même clé, donc jamais de double débit).
- Le bouton « − » annule le **dernier versement encore engagé**, pour son
  montant exact ; chaque versement est aussi annulable depuis la liste des
  mouvements. Il n'existe pas de retrait d'un montant arbitraire : le registre
  rembourse par référence, en tout-ou-rien.
- **Supprimer une cagnotte** rembourse tous ses versements. Si l'un échoue,
  rien n'est effacé — mieux vaut une cagnotte encore là que des Éclats perdus.
- **Valider une cagnotte** n'écrit rien : les Éclats ont déjà été dépensés.

## Garde-fous

- Aucune clé `service_role` dans le navigateur.
- Le solde n'est jamais stocké ni écrit côté client : il est la somme d'un
  journal. Le montant d'une cagnotte est dérivé de ses versements, jamais
  recopié — une divergence entre l'affichage et la comptabilité est donc
  structurellement impossible.
- Aucune écriture directe dans `eclats_ledger` : uniquement via les RPC
  atomiques.
- Une opération hors ligne n'est **jamais** présentée comme comptabilisée tant
  que le registre ne l'a pas confirmée.
- Effacer les données locales détruit les clés d'idempotence et rend les
  versements inannulables : l'application le dit avant d'effacer.
