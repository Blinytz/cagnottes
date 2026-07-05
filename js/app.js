'use strict';

/* Toasts (notifications éphémères) — global, utilisé aussi par le Store */
function toast(msg, type = 'info') {
  const root = document.getElementById('toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.innerHTML = msg;
  root.appendChild(el);
  setTimeout(() => el.classList.add('show'), 10);
  setTimeout(() => {
    el.classList.remove('show');
    setTimeout(() => el.remove(), 400);
  }, type === 'error' ? 5200 : 3200);
}

const App = (() => {

  /* ---------- Routage par hash ---------- */

  function parseRoute() {
    const h = location.hash.replace(/^#\/?/, '');
    const [seg, id] = h.split('/');
    if (seg === 'cagnotte' && id) return { name: 'cagnotte', id };
    if (['stats', 'archives', 'bourse', 'reglages'].includes(seg)) return { name: seg };
    return { name: 'home' };
  }

  function render() {
    const route = parseRoute();
    const viewEl = document.getElementById('view');
    const html = {
      home: () => Views.viewHome(),
      cagnotte: () => Views.viewCagnotte(route.id),
      stats: () => Views.viewStats(),
      archives: () => Views.viewArchives(),
      bourse: () => Views.viewBourse(),
      reglages: () => Views.viewReglages()
    }[route.name]();
    viewEl.innerHTML = html;
    updateHeader();
    updateNav(route);
    Views.afterRender(route);
  }

  /* Bandeau Bourse persistant : solde temps réel + alerte négatif */
  function updateHeader() {
    const solde = Store.state.bourse.solde;
    const el = document.getElementById('bourse-header');
    el.classList.toggle('negatif', solde < 0);
    el.querySelector('.bh-solde').textContent = U.fmtEUR(solde);
  }

  function updateNav(route) {
    document.querySelectorAll('#bottom-nav a').forEach(a => {
      a.classList.toggle('active', a.dataset.route === route.name);
    });
  }

  /* ---------- Actions +/− au palier ---------- */

  function stepPlus(id) {
    const c = Store.getCagnotte(id);
    if (!c) return;
    const res = Store.alimenter(id, c.palier);
    if (!res.ok) {
      if (res.reason === 'bourse_vide') toast('👛 Bourse vide ou négative : impossible d’alimenter la cagnotte.', 'error');
      return;
    }
    if (res.ajuste) {
      toast(`⚖️ Bourse insuffisante : seulement <strong>${U.fmtEUR(res.effectif)}</strong> transférés (au lieu de ${U.fmtEUR(c.palier)}). La Bourse est à 0 €.`, 'warn');
    }
    verifierObjectifAtteint(c);
  }

  function stepMinus(id) {
    const c = Store.getCagnotte(id);
    if (!c) return;
    const res = Store.retirer(id, c.palier);
    if (res.ok && res.ajuste) {
      toast(`⚖️ Seulement ${U.fmtEUR(res.effectif)} retirés : la cagnotte ne descend jamais sous 0 €.`, 'warn');
    }
  }

  function verifierObjectifAtteint(c) {
    if (c.statut === 'en_attente_validation') {
      toast(`🎯 <strong>${U.esc(c.nom)}</strong> a atteint son objectif ! Tu peux la valider.`, 'success');
    }
  }

  /* ---------- Délégation d'événements (clics) ---------- */

  document.addEventListener('click', async e => {
    const actEl = e.target.closest('[data-action]');
    if (!actEl) return;
    const action = actEl.dataset.action;
    const id = actEl.dataset.id;

    switch (action) {
      case 'goto-bourse':
        location.hash = '#/bourse';
        break;

      case 'open-cagnotte':
        /* Ignore le clic s'il vient d'un bouton ou du handle de drag */
        if (e.target.closest('button') || e.target.closest('[data-drag]')) return;
        location.hash = '#/cagnotte/' + actEl.dataset.id;
        break;

      case 'step-plus': stepPlus(id); break;
      case 'step-minus': stepMinus(id); break;

      case 'new-cagnotte': Views.cagnotteFormModal(); break;
      case 'edit-cagnotte': Views.cagnotteFormModal(Store.getCagnotte(id)); break;

      case 'delete-cagnotte': {
        const c = Store.getCagnotte(id);
        if (!c) return;
        const extra = (c.montantActuel > 0 && c.statut !== 'archivée')
          ? ` Les ${U.fmtEUR(c.montantActuel)} qu'elle contient retourneront dans la Bourse.` : '';
        if (await Views.confirmDialog(`Supprimer définitivement « ${U.esc(c.nom)} » ?${extra}`, { danger: true, okLabel: 'Supprimer' })) {
          Store.deleteCagnotte(id);
          toast('Cagnotte supprimée.');
          location.hash = '#/';
        }
        break;
      }

      case 'valider-cagnotte': {
        const c = Store.getCagnotte(id);
        if (Store.validerCagnotte(id).ok) Views.celebrate(c);
        break;
      }

      case 'reactiver-cagnotte': {
        e.stopPropagation();
        Store.reactiverCagnotte(id);
        toast('♻️ Cagnotte réactivée !', 'success');
        location.hash = '#/';
        break;
      }

      case 'reset-ordre':
        Store.resetOrdre();
        break;

      case 'set-range': {
        const key = actEl.closest('[data-range-key]').dataset.rangeKey;
        Views.ranges[key] = actEl.dataset.range;
        render();
        break;
      }

      case 'export-data': {
        const blob = new Blob([Store.exportJSON()], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = `cagnottes-sauvegarde-${U.todayKey()}.json`;
        a.click();
        URL.revokeObjectURL(a.href);
        toast('💾 Sauvegarde téléchargée.', 'success');
        break;
      }

      case 'import-data':
        document.getElementById('import-file').click();
        break;

      case 'reset-data':
        if (await Views.confirmDialog('Toutes tes données (cagnottes, Bourse, historiques) seront définitivement effacées. Pense à exporter avant !', { danger: true, okLabel: 'Tout effacer' })) {
          Store.resetAll();
          toast('Données effacées.');
          location.hash = '#/';
        }
        break;

      case 'modal-close':
        if (e.target === actEl) Views.closeModal();
        break;

      case 'modal-close-home':
        Views.closeModal();
        location.hash = '#/';
        break;
    }
  });

  /* ---------- Import de fichier JSON ---------- */

  document.addEventListener('change', async e => {
    if (e.target.id !== 'import-file') return;
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    const text = await file.text();
    if (await Views.confirmDialog('Importer ce fichier remplacera <strong>toutes</strong> tes données actuelles (cagnottes et Bourse). Continuer ?', { danger: true, okLabel: 'Importer' })) {
      const res = Store.importJSON(text);
      if (res.ok) {
        toast('✅ Données restaurées avec succès.', 'success');
        location.hash = '#/';
      } else {
        toast(res.reason === 'json_invalide'
          ? '❌ Fichier illisible : ce n’est pas du JSON valide.'
          : '❌ Fichier invalide : structure de sauvegarde non reconnue.', 'error');
      }
    }
  });

  /* ---------- Soumission des formulaires ---------- */

  /* Mémorise quel bouton (+/−) a déclenché la soumission */
  document.addEventListener('click', e => {
    const btn = e.target.closest('button[data-sens]');
    if (btn && btn.form) btn.form._sens = btn.dataset.sens;
  });

  document.addEventListener('submit', e => {
    const form = e.target;

    /* Création / édition de cagnotte */
    if (form.id === 'form-cagnotte') {
      e.preventDefault();
      const nom = form.nom.value.trim();
      const objectif = U.parseMontant(form.objectif.value);
      const palier = U.parseMontant(form.palier.value);
      if (!nom) return toast('Le nom est obligatoire.', 'error');
      if (!(objectif > 0)) return toast('L’objectif doit être un montant positif.', 'error');
      if (!(palier > 0)) return toast('Le palier doit être un montant positif.', 'error');
      const modal = form.closest('.modal');
      const image = modal._image || { type: 'emoji', value: '🎁' };
      const description = form.description.value.trim();
      const id = form.dataset.id;
      if (id) {
        Store.updateCagnotte(id, { nom, objectif, palier, image, description });
        toast('✅ Cagnotte mise à jour.', 'success');
      } else {
        Store.createCagnotte({ nom, objectif, palier, image, description });
        toast(`✨ Cagnotte « ${U.esc(nom)} » créée !`, 'success');
      }
      Views.closeModal();
      return;
    }

    /* Montant personnalisé sur une cagnotte */
    if (form.id === 'form-montant-libre') {
      e.preventDefault();
      const id = form.dataset.id;
      const c = Store.getCagnotte(id);
      let montant = U.parseMontant(form.montant.value);
      const note = form.note.value.trim();
      if (!Number.isFinite(montant) || montant === 0) return toast('Montant invalide.', 'error');
      /* Un montant saisi négatif force un retrait, quel que soit le bouton */
      let sens = form._sens || 'plus';
      if (montant < 0) { sens = 'minus'; montant = Math.abs(montant); }

      if (sens === 'plus') {
        const res = Store.alimenter(id, montant, note);
        if (!res.ok) {
          return toast(res.reason === 'bourse_vide'
            ? '👛 Bourse vide ou négative : impossible d’alimenter la cagnotte.'
            : 'Montant invalide.', 'error');
        }
        if (res.ajuste) {
          toast(`⚖️ Bourse insuffisante : seulement <strong>${U.fmtEUR(res.effectif)}</strong> transférés (au lieu de ${U.fmtEUR(montant)}). La Bourse est à 0 €.`, 'warn');
        } else {
          toast(`+${U.fmtEUR(res.effectif)} ajoutés 💪`, 'success');
        }
        verifierObjectifAtteint(c);
      } else {
        const res = Store.retirer(id, montant, note);
        if (!res.ok) {
          return toast(res.reason === 'cagnotte_vide' ? 'La cagnotte est déjà à 0 €.' : 'Montant invalide.', 'error');
        }
        toast(res.ajuste
          ? `⚖️ Seulement ${U.fmtEUR(res.effectif)} retirés (la cagnotte ne descend pas sous 0 €).`
          : `−${U.fmtEUR(res.effectif)} reversés à la Bourse.`, res.ajuste ? 'warn' : 'info');
      }
      return;
    }

    /* Mouvement manuel de Bourse */
    if (form.id === 'form-bourse') {
      e.preventDefault();
      let montant = U.parseMontant(form.montant.value);
      const note = form.note.value.trim();
      if (!Number.isFinite(montant) || montant === 0) return toast('Montant invalide.', 'error');
      const sens = form._sens || 'plus';
      if (sens === 'minus' && montant > 0) montant = -montant;
      const res = Store.mouvementManuelBourse(montant, note);
      if (res.ok) {
        toast(montant > 0 ? `+${U.fmtEUR(montant)} ajoutés à la Bourse 👛` : `${U.fmtEUR(montant)} débités de la Bourse.`, 'success');
      }
      return;
    }
  });

  /* Sauvegarde de la description à la volée (au blur) */
  document.addEventListener('blur', e => {
    if (e.target.id === 'cagnotte-desc') {
      Store.updateCagnotte(e.target.dataset.id, { description: e.target.value.trim() });
    }
  }, true);

  /* ---------- Initialisation ---------- */

  function init() {
    /* Tout mouvement redessine l'écran courant + le bandeau Bourse */
    Store.subscribe(() => render());
    window.addEventListener('hashchange', render);
    window.addEventListener('resize', () => Views.afterRender(parseRoute()));

    if (Store.state._corrupted) {
      toast('⚠️ Les données sauvegardées étaient corrompues et ont été réinitialisées.', 'error');
      delete Store.state._corrupted;
    }

    render();

    /* Service worker (PWA hors-ligne) */
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(err => console.warn('SW non enregistré :', err));
    }
  }

  return { init, render };
})();

document.addEventListener('DOMContentLoaded', App.init);
