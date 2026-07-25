// Bascule des données euro (v1) vers les Éclats (v2).
//
// Décision du 25/07/2026 : Cagnottes ne compte plus qu'en Éclats, cagnottes
// comprises, au taux fixe **1 € = 100 ✦**. Le taux rend tous les montants
// entiers sans perte (l'Éclat est indivisible) : 0,50 € → 50 ✦, 60 € → 6 000 ✦.
//
// La conversion est faite UNE SEULE FOIS, à la première ouverture, et laisse
// derrière elle une copie intégrale des données euro d'origine.
//
// Reconstruction du journal
// -------------------------
// Les versements deviennent la source de vérité (le montant d'une cagnotte en
// est déduit), donc l'historique euro est rejoué en versements plutôt que
// recopié : chaque apport devient un versement confirmé daté, chaque retrait
// annule les versements les plus récents (LIFO), en re-versant le reliquat
// quand le retrait ne consomme qu'une partie du dernier versement. C'est
// exactement la règle retenue pour l'avenir, donc l'historique reconstruit se
// comporte comme s'il avait toujours été tenu ainsi — mêmes dates, mêmes
// montants (×100), même solde final par cagnotte.

import { STATUT, REFUND_STATUT, APP_ID } from './eclats-cagnottes.js';

export const TAUX_EURO_ECLAT = 100;
export const SOLDE_INITIAL_ECLATS = 100;
export const VERSION_ECLATS = 2;

export const CLE_ETAT = 'cagnottes_app_state_v1';
export const CLE_SAUVEGARDE_EURO = 'cagnottes_sauvegarde_euro_v1';
export const CLE_OUVERTURE = 'cagnottes:ouverture:eclats-v2';

const ent = (v) => Math.round(Number(v) || 0);

function defaultUid() {
  return (typeof crypto !== 'undefined' && crypto.randomUUID)
    ? crypto.randomUUID()
    : `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/*
 * Rejoue l'historique euro d'une cagnotte en versements d'Éclats.
 * Retourne les versements créés (certains déjà remboursés) et l'engagement final.
 */
function rejouerCagnotte(c, { taux, uid, maintenant }) {
  const versements = [];
  const ouverts = []; // versements non remboursés, du plus ancien au plus récent

  function verser(montant, date, note) {
    if (montant <= 0) return;
    const rec = {
      id: uid(),
      cagnotteId: c.id,
      requested: montant,
      amount: montant,
      reason: 'Versement dans une cagnotte',
      note: note || undefined,
      statut: STATUT.CONFIRME,
      createdAt: date,
      confirmedAt: date,
      movementId: null,
      adjusted: false,
      idempotentReplay: false,
      refund: null,
      erreur: null,
      origine: 'bascule',
    };
    versements.push(rec);
    ouverts.push(rec);
  }

  function retirer(montant, date, note) {
    let reste = montant;
    while (reste > 0 && ouverts.length) {
      const v = ouverts.pop();
      const pris = Math.min(reste, v.amount);
      const reliquat = v.amount - pris;
      v.refund = {
        statut: REFUND_STATUT.CONFIRME,
        amount: v.amount,
        movementId: null,
        idempotentReplay: false,
        confirmedAt: date,
        motif: note ? `Retrait : ${note}` : 'Retrait de la cagnotte',
      };
      reste -= pris;
      // Le registre rembourse un versement en entier : le reliquat est re-versé.
      if (reliquat > 0) verser(reliquat, date, note);
    }
  }

  const mouvements = (Array.isArray(c.mouvements) ? [...c.mouvements] : [])
    .filter((m) => Number.isFinite(Number(m.montant)) && Number(m.montant) !== 0)
    .sort((a, b) => String(a.date).localeCompare(String(b.date)));

  mouvements.forEach((m) => {
    const montant = ent(Number(m.montant) * taux);
    if (montant > 0) verser(montant, m.date, m.note);
    else if (montant < 0) retirer(-montant, m.date, m.note);
  });

  /*
   * Recalage sur le montant réellement affiché avant la bascule. L'historique
   * peut être incomplet (données importées, cagnotte créée déjà alimentée) :
   * l'utilisateur doit retrouver exactement son montant, converti.
   */
  const dateFin = mouvements.length
    ? mouvements[mouvements.length - 1].date
    : (c.dateCreation || maintenant);
  const cible = Math.max(0, ent(Number(c.montantActuel) * taux));
  const reconstruit = ouverts.reduce((s, v) => s + v.amount, 0);
  if (reconstruit < cible) verser(cible - reconstruit, dateFin, 'Report de la bascule en Éclats');
  else if (reconstruit > cible) retirer(reconstruit - cible, dateFin, 'Report de la bascule en Éclats');

  return { versements, engagement: cible, ecart: cible - reconstruit };
}

/*
 * Conversion pure d'un état v1 (euros) en état v2 (Éclats).
 * Ne touche à aucun stockage : retourne tout ce qu'il faut écrire.
 */
export function convertirEtatV1(ancien, {
  taux = TAUX_EURO_ECLAT,
  soldeInitial = SOLDE_INITIAL_ECLATS,
  uid = defaultUid,
  maintenant = new Date().toISOString(),
} = {}) {
  const source = (ancien && typeof ancien === 'object') ? ancien : {};
  const anciennesCagnottes = Array.isArray(source.cagnottes) ? source.cagnottes : [];

  const cagnottes = [];
  const versements = {};
  const evenements = [];
  const arrondis = [];
  let totalEngage = 0;

  anciennesCagnottes.forEach((c, i) => {
    const objectifEuro = Number(c.objectif) || 0;
    const palierEuro = Number(c.palier) || 0;
    [['objectif', objectifEuro], ['palier', palierEuro]].forEach(([champ, val]) => {
      if (Math.abs(val * taux - Math.round(val * taux)) > 1e-9) {
        arrondis.push({ cagnotte: c.nom || c.id, champ, euro: val, eclats: ent(val * taux) });
      }
    });

    cagnottes.push({
      id: c.id,
      nom: String(c.nom || 'Sans nom'),
      image: c.image && c.image.type ? c.image : { type: 'emoji', value: '🎁' },
      description: String(c.description || ''),
      objectif: Math.max(1, ent(objectifEuro * taux)),
      palier: Math.max(1, ent(palierEuro * taux)),
      statut: ['en_cours', 'en_attente_validation', 'archivée'].includes(c.statut) ? c.statut : 'en_cours',
      dateCreation: c.dateCreation || maintenant,
      dateArchivage: c.dateArchivage || null,
      ordreAffichage: Number.isFinite(c.ordreAffichage) ? c.ordreAffichage : i + 1,
    });

    const { versements: liste, engagement } = rejouerCagnotte(c, { taux, uid, maintenant });
    liste.forEach((v) => { versements[v.id] = v; });
    totalEngage += engagement;

    liste.forEach((v) => {
      evenements.push({ date: v.confirmedAt, type: 'spend', versement: v });
      if (v.refund?.statut === REFUND_STATUT.CONFIRME) {
        evenements.push({ date: v.refund.confirmedAt, type: 'refund', versement: v });
      }
    });
  });

  evenements.sort((a, b) => String(a.date).localeCompare(String(b.date)));

  /*
   * Mouvement d'ouverture : il doit couvrir le solde de départ ET tout ce qui
   * est déjà engagé dans les cagnottes, sinon le journal rejoué décrirait des
   * dépenses sans provision. Après rejeu, le disponible vaut exactement
   * `soldeInitial`.
   */
  const premiere = evenements.length ? evenements[0].date : maintenant;
  const dateOuverture = new Date(new Date(premiere).getTime() - 1000).toISOString();
  const ouverture = ent(soldeInitial) + totalEngage;

  const mouvements = [{
    amount: ouverture,
    appId: APP_ID,
    kind: 'adjustment',
    reason: "Solde d'ouverture en Éclats (bascule du 25/07/2026)",
    referenceType: 'ouverture',
    referenceId: null,
    idempotencyKey: CLE_OUVERTURE,
    occurredAt: dateOuverture,
    metadata: { taux, soldeInitial: ent(soldeInitial), engageALaBascule: totalEngage },
  }];

  evenements.forEach(({ type, versement: v }) => {
    if (type === 'spend') {
      mouvements.push({
        amount: -v.amount,
        appId: APP_ID,
        kind: 'spend',
        reason: v.reason,
        referenceType: 'cagnotte_versement',
        referenceId: v.id,
        idempotencyKey: `cagnottes:versement:${v.id}`,
        occurredAt: v.confirmedAt,
        metadata: { cagnotteId: v.cagnotteId },
      });
    } else {
      mouvements.push({
        amount: v.refund.amount,
        appId: APP_ID,
        kind: 'refund',
        reason: v.refund.motif,
        referenceType: 'cagnotte_versement',
        referenceId: v.id,
        idempotencyKey: `cagnottes:remboursement:${v.id}`,
        occurredAt: v.refund.confirmedAt,
        metadata: { cagnotteId: v.cagnotteId },
      });
    }
  });

  return {
    etat: {
      version: VERSION_ECLATS,
      cagnottes,
      ordreManuel: !!source.ordreManuel,
    },
    versements,
    mouvements,
    rapport: {
      taux,
      soldeInitial: ent(soldeInitial),
      soldeEuroAbandonne: Number(source.bourse?.solde) || 0,
      nbCagnottes: cagnottes.length,
      nbVersements: Object.keys(versements).length,
      totalEngage,
      ouverture,
      arrondis,
    },
  };
}

/* État de départ d'une installation neuve : pas de conversion, juste l'ouverture. */
export function etatInitial({
  soldeInitial = SOLDE_INITIAL_ECLATS,
  maintenant = new Date().toISOString(),
} = {}) {
  return {
    etat: { version: VERSION_ECLATS, cagnottes: [], ordreManuel: false },
    versements: {},
    mouvements: [{
      amount: ent(soldeInitial),
      appId: APP_ID,
      kind: 'adjustment',
      reason: "Solde d'ouverture en Éclats",
      referenceType: 'ouverture',
      referenceId: null,
      idempotencyKey: CLE_OUVERTURE,
      occurredAt: maintenant,
      metadata: { soldeInitial: ent(soldeInitial) },
    }],
    rapport: {
      taux: TAUX_EURO_ECLAT, soldeInitial: ent(soldeInitial), soldeEuroAbandonne: 0,
      nbCagnottes: 0, nbVersements: 0, totalEngage: 0, ouverture: ent(soldeInitial), arrondis: [],
    },
  };
}

/* Une sauvegarde exportée est-elle encore en euros ? */
export function estFormatEuro(etat) {
  return !!etat && typeof etat === 'object'
    && Number(etat.version || 1) < VERSION_ECLATS
    && (!!etat.bourse || Array.isArray(etat.cagnottes));
}
