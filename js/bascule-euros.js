// Bascule Cagnottes : version 2 (tout en Éclats) → version 3 (tout en euros).
//
// Décision du 26/07/2026 : les cagnottes reviennent aux euros, qui ont plus de
// sens pour de l'épargne. Les Éclats restent la monnaie de l'écosystème et ne
// deviennent des euros que par une CONVERSION explicite, à la parité fixe
// 100 ✦ = 1 € (voir `bourse.js`).
//
// Deux propriétés rendent cette bascule sûre :
//
//   1. **Aucun calcul.** La bascule précédente valait 1 € = 100 ✦, donc
//      1 Éclat = 1 centime. Un objectif de 60 000 ✦ EST 600,00 €. Les nombres
//      stockés ne changent pas, seule leur unité change. Ni arrondi, ni perte.
//
//   2. **Aucun Éclat perdu.** Les versements de test faits en Éclats sont
//      intégralement remboursés au registre commun AVANT la bascule (orchestré
//      par le Store). Les cagnottes repartent vides, avec leurs noms, objectifs,
//      images et ordre intacts. La Bourse démarre donc à 0 € : c'est à toi d'y
//      convertir des Éclats.
//
// Ce module ne contient que des fonctions PURES : il ne touche ni au stockage
// ni au réseau. Le Store décide quand les appliquer.

export const VERSION_EUROS = 3;
export const CLE_SAUVEGARDE_ECLATS = 'cagnottes_sauvegarde_eclats_v2';

/* Un état est-il encore dans le format « tout en Éclats » (version 2) ? */
export function estFormatEclats(etat) {
  return !!etat && typeof etat === 'object' && Number(etat.version) === 2;
}

export function estFormatEuros(etat) {
  return !!etat && typeof etat === 'object' && Number(etat.version) >= VERSION_EUROS;
}

/*
 * Convertit l'état métier v2 → v3. Les cagnottes sont vidées (leurs versements
 * ayant été remboursés) mais conservent tout le reste. Les montants gardent
 * leur valeur numérique : un Éclat devient un centime.
 */
export function convertirEtatEnEuros(ancien) {
  const cagnottes = (Array.isArray(ancien?.cagnottes) ? ancien.cagnottes : []).map((c, i) => ({
    id: c.id,
    nom: String(c.nom || 'Sans nom'),
    image: c.image && c.image.type ? c.image : { type: 'emoji', value: '🎁' },
    description: String(c.description || ''),
    // 1 ✦ = 1 centime : la valeur ne bouge pas, l'unité change.
    objectif: Math.max(1, Math.round(Number(c.objectif) || 1)),
    palier: Math.max(1, Math.round(Number(c.palier) || 1)),
    // Les versements ont été remboursés : toute cagnotte non archivée repart
    // à zéro et redevient « en cours ».
    statut: c.statut === 'archivée' ? 'archivée' : 'en_cours',
    dateCreation: c.dateCreation || new Date().toISOString(),
    dateArchivage: c.statut === 'archivée' ? (c.dateArchivage || null) : null,
    ordreAffichage: Number.isFinite(c.ordreAffichage) ? c.ordreAffichage : i + 1,
  }));

  return {
    etat: {
      version: VERSION_EUROS,
      ordreManuel: !!ancien?.ordreManuel,
      cagnottes,
    },
    rapport: {
      nbCagnottes: cagnottes.length,
      nbArchivees: cagnottes.filter((c) => c.statut === 'archivée').length,
      totalObjectifs: cagnottes.reduce((s, c) => s + c.objectif, 0),
    },
  };
}

/* État neuf, pour une installation sans données. */
export function etatInitialEuros() {
  return { version: VERSION_EUROS, ordreManuel: false, cagnottes: [] };
}

/*
 * Prépare le plan de remboursement : la liste des versements encore engagés,
 * qui doivent tous être rendus au registre commun avant la bascule.
 * `versements` est le journal du contrôleur (`eclats-cagnottes.js`).
 */
export function planRemboursement(versements) {
  const liste = Object.values(versements || {}).filter(
    (v) => v.statut === 'confirme' && v.refund?.statut !== 'confirme',
  );
  return {
    versements: liste,
    nb: liste.length,
    totalEclats: liste.reduce((s, v) => s + (Number(v.amount) || 0), 0),
  };
}
