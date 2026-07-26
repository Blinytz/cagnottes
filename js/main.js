// Point d'entrée : assemble le taux de change, la Bourse, le journal des
// versements et le Store, puis démarre l'application.
//
//     Éclats communs ──(conversion au taux)──▶ Bourse (€) ──▶ Cagnottes (€)
//
// Deux registres cohabitent, volontairement :
//   * `partage` — le registre commun d'Éclats (Supabase), touché UNIQUEMENT
//     par les conversions ;
//   * `journalBourse` — la Bourse en euros, locale : c'est elle qui finance les
//     versements dans les cagnottes. Verser ne dépend donc pas du réseau.

import { createRegistre } from './eclats-registre.js';
import { createRegistreLocal } from './eclats-local.js';
import { createCagnottesEclats, ETAT_STORAGE_KEY } from './eclats-cagnottes.js';
import { createTaux, FENETRES } from './bourse-taux.js';
import { createBourse, BOURSE_JOURNAL_KEY } from './bourse.js';
import { creerStore } from './store.js';

const uid = () => U.uid();

/* Registre commun d'Éclats : porte la session et sert les conversions. */
const partage = createRegistre();
window.Registre = partage;

/* Moteur du taux de change : démarre et rattrape le temps passé hors ligne. */
const taux = createTaux();
taux.init();
window.Taux = taux;
window.FENETRES_TAUX = FENETRES;   // lu par l'écran Change pour ses boutons

/* La Bourse : journal local en centimes d'euros. */
const journalBourse = createRegistreLocal({ uid, cle: BOURSE_JOURNAL_KEY });
const bourse = createBourse({ journal: journalBourse, eclats: partage, taux, uid });

/* Versements dans les cagnottes : financés par la Bourse, en centimes. */
const versements = createCagnottesEclats({
  ledger: journalBourse, uid, cle: 'cagnottes_versements_euro_v1',
});

/*
 * Contrôleur historique, branché sur le registre commun et sur l'ancienne clé :
 * il ne sert qu'à REMBOURSER les versements de test faits en Éclats, au moment
 * de la bascule vers les euros.
 */
const ancienVersements = createCagnottesEclats({
  ledger: partage, uid, cle: ETAT_STORAGE_KEY,
});

let basculeRequise = false;

window.Store = creerStore({
  versements,
  bourse,
  ancienVersements,
  onBasculeRequise: () => { basculeRequise = true; },
});

/* Le taux continue de vivre pendant que l'app est ouverte. */
setInterval(() => {
  taux.tick();
  if (location.hash.startsWith('#/change')) App.majTaux();
}, 10_000);

App.init().then(() => {
  if (basculeRequise) App.proposerBascule();
});
