# Intégration de Cagnottes au registre commun d'Éclats

Objectif : le solde disponible de Cagnottes vient du **registre commun** (le même
projet Supabase que Pronos), plus de la « Bourse » locale. Un versement consomme
des Éclats communs ; l'annuler rembourse exactement une fois.

## Ce qui est livré (local, réversible, testé)

| Fichier | Rôle |
|---|---|
| `js/eclats-registre.js` | Adaptateur commun du registre (auth mot de passe, RPC `eclats_balance` / `eclats_spend` / `eclats_refund` / `eclats_aggregates_by_app`). **Clé publishable uniquement**, aucun secret. |
| `js/eclats-cagnottes.js` | Contrôleur : versement = dépense plafonnée confirmée serveur ; annulation = remboursement exactement-une-fois ; états `en_attente` / `confirme` / `refuse` / `erreur` ; garde double-clic ; persistance dans une clé dédiée. |
| `tests/eclats.test.mjs` | 11 tests (`node --test`) contre un faux registre reproduisant la sémantique SQL. |

Le contrôleur écrit dans `localStorage['cagnottes_eclats_v1']` — **séparé** de
`localStorage['cagnottes_app_state_v1']`. Les cagnottes, objectifs, icônes, ordre
et historiques existants **ne sont ni touchés ni convertis**.

Les RPC utilisées sont définies dans la migration `apps/pronos/sql/registre_commun.sql`.

## Modèle cible dans l'UI (à câbler)

- Le bandeau haut n'affiche plus une « Bourse » locale mais le **solde commun**
  (`ec.soldeDisponible()`), plus les **Éclats engagés** (`ec.engageTotal()`).
- « Alimenter une cagnotte » appelle `ec.verser(cagnotteId, montant)` :
  - succès → afficher « confirmé » et le montant réellement versé (peut être
    plafonné : `adjusted`) ;
  - `solde_insuffisant` → message clair, rien n'est comptabilisé ;
  - `reseau` → état « en attente / erreur », bouton **Réessayer** (`ec.reprendre`).
- « Retirer / supprimer un versement » appelle `ec.annuler(versementId)`
  (remboursement idempotent).
- Une opération hors ligne n'est **jamais** présentée comme comptabilisée tant que
  le serveur ne l'a pas confirmée (statut `en_attente`).
- Les montants passent des **euros** aux **Éclats (✦)** pour les nouvelles
  opérations connectées.

## Ce qui reste bloqué sur une décision / action de Jérémy

1. **Exécuter la migration** `registre_commun.sql` sur la base (voir
   `apps/pronos/sql/registre_commun_*.sql`). L'UI connectée **ne doit pas** être
   publiée avant.
2. **Session Supabase** dans Cagnottes (même compte que Pronos) — écran de
   connexion à ajouter, réutilisant `eclats-registre.js`.
3. **Stratégie de bascule** des anciennes données euro (aucune conversion
   automatique ; options à présenter le moment venu).

## Garde-fous

- Aucune clé `service_role` dans le navigateur.
- Le solde n'est jamais stocké ni écrit côté client : il est lu du registre.
- Aucune écriture directe dans `eclats_ledger` : uniquement via les RPC atomiques.
- Le mode connecté sera activé explicitement ; par défaut l'app reste inchangée
  et ne dépend pas de la migration.
