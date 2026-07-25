'use strict';

/*
 * Mini-moteur de graphique en ligne sur <canvas>, sans dépendance.
 * Dessine une série { date:'YYYY-MM-DD', value } avec dégradé sous la courbe,
 * ligne d'objectif optionnelle, et gestion des cas limites (0 ou 1 point).
 */
const Charts = (() => {

  function cssVar(name, fallback) {
    const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
    return v || fallback;
  }

  function draw(canvas, serie, { goal = null } = {}) {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth || 320;
    const h = canvas.clientHeight || 180;
    canvas.width = w * dpr;
    canvas.height = h * dpr;
    const ctx = canvas.getContext('2d');
    ctx.scale(dpr, dpr);
    ctx.clearRect(0, 0, w, h);

    const cAccent = cssVar('--accent', '#177E5B');
    const cGold = cssVar('--gold', '#E8A33D');
    const cMuted = cssVar('--muted', '#8A8578');
    const font = '11px system-ui, sans-serif';

    if (!serie.length) {
      ctx.fillStyle = cMuted;
      ctx.font = '13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.fillText('Pas encore assez de données', w / 2, h / 2);
      return;
    }

    const pad = { top: 14, right: 12, bottom: 24, left: 46 };
    const iw = w - pad.left - pad.right;
    const ih = h - pad.top - pad.bottom;

    const values = serie.map(p => p.value);
    let min = Math.min(0, ...values);
    let max = Math.max(...values, goal ?? -Infinity);
    if (max === min) max = min + 1;
    const span = max - min;
    min -= span * 0.05;
    max += span * 0.08;

    const x = i => pad.left + (serie.length === 1 ? iw / 2 : (i / (serie.length - 1)) * iw);
    const y = v => pad.top + ih - ((v - min) / (max - min)) * ih;

    // Grille horizontale + labels d'axe Y (4 lignes)
    ctx.font = font;
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    for (let i = 0; i <= 3; i++) {
      const v = min + ((max - min) * i) / 3;
      const yy = y(v);
      ctx.strokeStyle = 'rgba(0,0,0,0.06)';
      ctx.beginPath();
      ctx.moveTo(pad.left, yy);
      ctx.lineTo(w - pad.right, yy);
      ctx.stroke();
      ctx.fillStyle = cMuted;
      ctx.fillText(formatShort(v), pad.left - 6, yy);
    }

    // Ligne de zéro si le solde passe en négatif
    if (min < 0 && max > 0) {
      ctx.strokeStyle = 'rgba(0,0,0,0.2)';
      ctx.setLineDash([2, 3]);
      ctx.beginPath();
      ctx.moveTo(pad.left, y(0));
      ctx.lineTo(w - pad.right, y(0));
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Ligne d'objectif
    if (goal != null && goal >= min && goal <= max) {
      ctx.strokeStyle = cGold;
      ctx.lineWidth = 1.5;
      ctx.setLineDash([6, 4]);
      ctx.beginPath();
      ctx.moveTo(pad.left, y(goal));
      ctx.lineTo(w - pad.right, y(goal));
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = cGold;
      ctx.textAlign = 'left';
      ctx.fillText('🎯 ' + formatShort(goal), pad.left + 4, y(goal) - 8);
    }

    // Aire sous la courbe
    if (serie.length > 1) {
      const grad = ctx.createLinearGradient(0, pad.top, 0, h - pad.bottom);
      grad.addColorStop(0, hexAlpha(cAccent, 0.25));
      grad.addColorStop(1, hexAlpha(cAccent, 0.02));
      ctx.beginPath();
      serie.forEach((p, i) => i === 0 ? ctx.moveTo(x(i), y(p.value)) : ctx.lineTo(x(i), y(p.value)));
      ctx.lineTo(x(serie.length - 1), y(Math.max(min, 0)));
      ctx.lineTo(x(0), y(Math.max(min, 0)));
      ctx.closePath();
      ctx.fillStyle = grad;
      ctx.fill();

      // Courbe
      ctx.beginPath();
      serie.forEach((p, i) => i === 0 ? ctx.moveTo(x(i), y(p.value)) : ctx.lineTo(x(i), y(p.value)));
      ctx.strokeStyle = cAccent;
      ctx.lineWidth = 2.5;
      ctx.lineJoin = 'round';
      ctx.stroke();
    }

    // Point final (toujours visible, même série d'un seul point)
    const last = serie[serie.length - 1];
    ctx.beginPath();
    ctx.arc(x(serie.length - 1), y(last.value), 4, 0, Math.PI * 2);
    ctx.fillStyle = cAccent;
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.stroke();

    // Labels de dates (première, milieu, dernière)
    ctx.fillStyle = cMuted;
    ctx.font = font;
    ctx.textBaseline = 'alphabetic';
    const labels = serie.length > 2
      ? [0, Math.floor((serie.length - 1) / 2), serie.length - 1]
      : serie.map((_, i) => i);
    [...new Set(labels)].forEach(i => {
      ctx.textAlign = i === 0 ? 'left' : (i === serie.length - 1 ? 'right' : 'center');
      ctx.fillText(U.fmtDateKey(serie[i].date), x(i), h - 8);
    });
  }

  function formatShort(v) {
    if (Math.abs(v) >= 1000) return (v / 1000).toLocaleString('fr-FR', { maximumFractionDigits: 1 }) + ' k✦';
    return v.toLocaleString('fr-FR', { maximumFractionDigits: 0 }) + ' ✦';
  }

  /* Convertit une couleur hex (#RRGGBB) en rgba avec alpha */
  function hexAlpha(hex, a) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex.trim());
    if (!m) return `rgba(23,126,91,${a})`;
    return `rgba(${parseInt(m[1], 16)},${parseInt(m[2], 16)},${parseInt(m[3], 16)},${a})`;
  }

  return { draw };
})();
