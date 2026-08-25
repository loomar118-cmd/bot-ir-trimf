/**************************************************************************************
 *  BOT TELEGRAM — CALCUL DE L'IR (RAS SALAIRES) ET DE LA TRIMF — SÉNÉGAL
 *  Version Node.js pour hébergement Render (webhook Telegram direct, sans redirection).
 *
 *  Le jeton du bot n'est PAS dans ce fichier : il est lu dans la variable
 *  d'environnement TELEGRAM_TOKEN configurée dans Render.
 **************************************************************************************/

const express = require('express');
const { createClient } = require('redis');

const TOKEN = process.env.TELEGRAM_TOKEN;
const BASE_URL = process.env.BASE_URL || '';
const REDIS_URL = process.env.REDIS_URL || '';
const PORT = process.env.PORT || 3000;
const API = 'https://api.telegram.org/bot' + TOKEN + '/';

// Taux applicable au-delà de 50 000 000 F de revenu net imposable.
const TAUX_AU_DELA_50M = 0.40;


/* ====================================================================================
   BARÈMES
   ==================================================================================== */

const TRANCHES_IR = [
  { de: 0,        a: 630000,   taux: 0.00 },
  { de: 630000,   a: 1500000,  taux: 0.20 },
  { de: 1500000,  a: 4000000,  taux: 0.30 },
  { de: 4000000,  a: 8000000,  taux: 0.35 },
  { de: 8000000,  a: 13500000, taux: 0.37 },
  { de: 13500000, a: 50000000, taux: 0.40 },
  { de: 50000000, a: Infinity, taux: TAUX_AU_DELA_50M }
];

const REDUCTIONS = {
  '1.0': { taux: 0.00, min: 0,      max: 0 },
  '1.5': { taux: 0.10, min: 100000, max: 300000 },
  '2.0': { taux: 0.15, min: 200000, max: 650000 },
  '2.5': { taux: 0.20, min: 300000, max: 1100000 },
  '3.0': { taux: 0.25, min: 400000, max: 1650000 },
  '3.5': { taux: 0.30, min: 500000, max: 2030000 },
  '4.0': { taux: 0.35, min: 600000, max: 2490000 },
  '4.5': { taux: 0.40, min: 700000, max: 2755000 },
  '5.0': { taux: 0.45, min: 800000, max: 3180000 }
};

const TRANCHES_TRIMF = [
  { plafond: 600000,   montant: 900 },
  { plafond: 1000000,  montant: 3600 },
  { plafond: 2000000,  montant: 4800 },
  { plafond: 7000000,  montant: 12000 },
  { plafond: 12000000, montant: 18000 },
  { plafond: Infinity, montant: 36000 }
];

const ABATTEMENT_TAUX = 0.30;
const ABATTEMENT_PLAFOND = 900000;
const PARTS_MAX = 5;


/* ====================================================================================
   MOTEUR DE CALCUL
   ==================================================================================== */

function nombreDeParts(situation, conjointSansRevenus, enfants) {
  let parts = (situation === 'marie') ? 1.5 : 1;
  if (situation === 'marie' && conjointSansRevenus) parts += 0.5;
  parts += 0.5 * enfants;
  return Math.min(parts, PARTS_MAX);
}

function calculerIRBareme(net) {
  let total = 0;
  const detail = [];
  for (const t of TRANCHES_IR) {
    if (net <= t.de) break;
    const base = Math.min(net, t.a) - t.de;
    const montant = base * t.taux;
    total += montant;
    if (t.taux > 0) detail.push({ de: t.de, a: t.a, taux: t.taux, base, montant });
  }
  return { total: Math.round(total), detail };
}

function calculerReduction(irBareme, parts) {
  const r = REDUCTIONS[parts.toFixed(1)];
  if (!r || r.taux === 0) return { montant: 0, taux: 0, min: 0, max: 0, theorique: 0 };
  const theorique = irBareme * r.taux;
  let retenu = theorique;
  if (retenu < r.min) retenu = r.min;
  if (retenu > r.max) retenu = r.max;
  return { montant: Math.round(retenu), taux: r.taux, min: r.min, max: r.max,
           theorique: Math.round(theorique) };
}

function calculerTRIMF(brut, conjointSansRevenus) {
  let base = 36000;
  for (const t of TRANCHES_TRIMF) {
    if (brut < t.plafond) { base = t.montant; break; }
  }
  return { base, total: conjointSansRevenus ? base * 2 : base, double: conjointSansRevenus };
}

function liquider(brut, situation, conjointSansRevenus, enfants) {
  const abattement = Math.min(brut * ABATTEMENT_TAUX, ABATTEMENT_PLAFOND);
  let net = Math.floor((brut - abattement) / 1000) * 1000;
  if (net < 0) net = 0;

  const parts = nombreDeParts(situation, conjointSansRevenus, enfants);
  const ir = calculerIRBareme(net);
  const reduction = calculerReduction(ir.total, parts);
  const irDu = Math.max(0, ir.total - reduction.montant);
  const trimf = calculerTRIMF(brut, conjointSansRevenus);

  return { brut, abattement: Math.round(abattement), net, parts,
           irBareme: ir.total, detail: ir.detail, reduction, irDu, trimf,
           total: irDu + trimf.total };
}


/* ====================================================================================
   OUTILS TELEGRAM
   ==================================================================================== */

async function tg(methode, donnees) {
  try {
    const rep = await fetch(API + methode, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(donnees)
    });
    return await rep.json();
  } catch (err) {
    console.error('Erreur appel Telegram ' + methode + ' :', err.message);
    return null;
  }
}

function envoyer(chatId, texte, clavier) {
  const msg = { chat_id: chatId, text: texte, parse_mode: 'HTML',
                disable_web_page_preview: true };
  if (clavier) msg.reply_markup = { inline_keyboard: clavier };
  return tg('sendMessage', msg);
}

function fmt(n) {
  return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ');
}

function pct(t) {
  return (t * 100).toString().replace('.', ',') + ' %';
}

// Mémoire de session, en mémoire vive (une fiche par utilisateur, purgée après 1 h).
const sessions = new Map();

function lireEtat(chatId) {
  const s = sessions.get(chatId);
  if (!s) return {};
  if (Date.now() - s.horodatage > 3600000) { sessions.delete(chatId); return {}; }
  return s.donnees;
}

function ecrireEtat(chatId, donnees) {
  sessions.set(chatId, { donnees, horodatage: Date.now() });
}

function effacerEtat(chatId) {
  sessions.delete(chatId);
}

// Anti-doublon : un même update_id n'est traité qu'une seule fois.
const vus = new Set();
function dejaTraite(updateId) {
  if (vus.has(updateId)) return true;
  vus.add(updateId);
  if (vus.size > 5000) vus.clear();
  return false;
}


/* ====================================================================================
   COMPTEUR D'UTILISATION
   ------------------------------------------------------------------------------------
   Stocké dans l'instance Key Value de Render. Si elle est indisponible, le bot
   continue de fonctionner normalement avec un comptage en mémoire vive.
   ==================================================================================== */

const CLE_UTILISATEURS = 'irtrimf:utilisateurs';   // ensemble des chat_id rencontrés
const CLE_SIMULATIONS  = 'irtrimf:simulations';    // nombre de calculs aboutis

let baseKV = null;
const secours = { utilisateurs: new Set(), simulations: 0 };

async function connecterBase() {
  if (!REDIS_URL) {
    console.log('Aucune base configurée : comptage en mémoire vive.');
    return;
  }
  try {
    const client = createClient({ url: REDIS_URL });
    client.on('error', (e) => console.error('Base indisponible :', e.message));
    await client.connect();
    baseKV = client;
    console.log('Base de comptage connectée.');
  } catch (err) {
    console.error('Connexion à la base impossible :', err.message);
  }
}

/** Enregistre le passage d'un utilisateur (sans effet s'il est déjà connu). */
async function enregistrerUtilisateur(chatId) {
  try {
    if (baseKV) return await baseKV.sAdd(CLE_UTILISATEURS, String(chatId));
  } catch (err) {
    console.error('Ecriture utilisateur impossible :', err.message);
  }
  secours.utilisateurs.add(String(chatId));
}

/** Incrémente le nombre de simulations abouties. */
async function enregistrerSimulation() {
  try {
    if (baseKV) return await baseKV.incr(CLE_SIMULATIONS);
  } catch (err) {
    console.error('Ecriture simulation impossible :', err.message);
  }
  secours.simulations += 1;
}

/** Renvoie { utilisateurs, simulations }. */
async function lireCompteurs() {
  try {
    if (baseKV) {
      const utilisateurs = await baseKV.sCard(CLE_UTILISATEURS);
      const simulations = parseInt(await baseKV.get(CLE_SIMULATIONS), 10) || 0;
      return { utilisateurs, simulations };
    }
  } catch (err) {
    console.error('Lecture des compteurs impossible :', err.message);
  }
  return { utilisateurs: secours.utilisateurs.size, simulations: secours.simulations };
}

function ligneCompteur(c) {
  const u = c.utilisateurs + (c.utilisateurs > 1 ? ' salariés ont' : ' salarié a');
  const s = c.simulations + (c.simulations > 1 ? ' simulations réalisées' : ' simulation réalisée');
  return '👥 ' + u + ' déjà utilisé ce calculateur — ' + s + '.';
}


/* ====================================================================================
   DIALOGUE
   ==================================================================================== */

async function traiterUpdate(update) {
  if (update.update_id && dejaTraite(update.update_id)) {
    console.log('Doublon ignore : update_id ' + update.update_id);
    return;
  }
  if (update.message && update.message.text) return traiterMessage(update.message);
  if (update.callback_query) return traiterBouton(update.callback_query);
}

async function traiterMessage(message) {
  const chatId = message.chat.id;
  const texte = (message.text || '').trim();

  enregistrerUtilisateur(chatId);

  if (texte === '/stats') {
    const c = await lireCompteurs();
    return envoyer(chatId,
      "📈 <b>Utilisation du calculateur</b>\n\n" +
      "Utilisateurs : <b>" + fmt(c.utilisateurs) + "</b>\n" +
      "Simulations abouties : <b>" + fmt(c.simulations) + "</b>\n\n" +
      "🔁 Tapez /calcul pour lancer une simulation.");
  }

  if (texte === '/start' || texte === '/calcul' || texte === '/aide') {
    effacerEtat(chatId);
    return demanderSalaire(chatId, texte === '/aide');
  }

  const montant = parseInt(texte.replace(/[^0-9]/g, ''), 10);
  if (isNaN(montant) || montant <= 0) {
    return envoyer(chatId,
      "Je n'ai pas reconnu de montant. Envoyez uniquement votre <b>salaire brut " +
      "imposable annuel</b> en chiffres, par exemple : <code>5497607</code>\n\n" +
      "Ou tapez /calcul pour recommencer.");
  }
  if (montant > 2000000000) {
    return envoyer(chatId, "Ce montant paraît anormalement élevé. Vérifiez votre saisie, " +
                           "puis renvoyez-le.");
  }

  ecrireEtat(chatId, { brut: montant });
  return demanderSituation(chatId, montant);
}

async function traiterBouton(cb) {
  const chatId = cb.message.chat.id;
  const data = cb.data || '';
  const etat = lireEtat(chatId);

  enregistrerUtilisateur(chatId);

  await tg('answerCallbackQuery', { callback_query_id: cb.id });

  if (!etat.brut) {
    return envoyer(chatId,
      "Ces boutons appartiennent à une simulation précédente.\n\n" +
      "➡️ Envoyez-moi simplement votre <b>salaire brut imposable annuel</b> " +
      "en chiffres (exemple : <code>5497607</code>) et je reprends le calcul.");
  }

  const partie = data.split('|');

  if (partie[0] === 'S') {
    etat.situation = partie[1];
    ecrireEtat(chatId, etat);
    if (etat.situation === 'marie') return demanderConjoint(chatId);
    etat.conjoint = false;
    ecrireEtat(chatId, etat);
    return demanderEnfants(chatId);
  }

  if (partie[0] === 'C') {
    etat.conjoint = (partie[1] === '1');
    ecrireEtat(chatId, etat);
    return demanderEnfants(chatId);
  }

  if (partie[0] === 'E') {
    etat.enfants = parseInt(partie[1], 10);
    await enregistrerSimulation();
    await envoyerResultat(chatId, etat);
    return effacerEtat(chatId);
  }
}

function demanderSalaire(chatId, avecAide) {
  let texte =
    "👋 <b>Calculateur IR + TRIMF — salariés du Sénégal</b>\n\n" +
    "Je calcule votre <b>impôt sur le revenu (retenue à la source sur salaires)</b> et " +
    "votre <b>TRIMF</b> pour une année complète.\n\n" +
    "➡️ Envoyez-moi votre <b>salaire brut imposable annuel</b> en chiffres " +
    "(exemple : <code>5497607</code>).\n\n" +
    "<i>Il s'agit du cumul annuel de vos rémunérations imposables — salaire de base, " +
    "primes, indemnités et avantages en nature imposables — après déduction des " +
    "cotisations sociales obligatoires (retraite) et avant l'abattement de 30 % pour " +
    "frais professionnels, que j'applique moi-même.</i>";
  if (avecAide) {
    texte +=
      "\n\nℹ️ Ce montant figure sur votre bulletin de paie de décembre, ou sur votre " +
      "attestation annuelle de salaire, sous l'intitulé « brut imposable » ou « base " +
      "imposable ». Ne saisissez ni le salaire net perçu, ni le brut avant cotisations.";
  }
  return envoyer(chatId, texte);
}

function demanderSituation(chatId, montant) {
  return envoyer(chatId,
    "Salaire brut imposable annuel : <b>" + fmt(montant) + " F CFA</b>\n\n" +
    "Quelle est votre situation matrimoniale ?",
    [[{ text: '💍 Marié(e)', callback_data: 'S|marie' },
      { text: '🙋 Célibataire', callback_data: 'S|celib' }]]);
}

function demanderConjoint(chatId) {
  return envoyer(chatId,
    "Votre conjoint(e) dispose-t-il/elle de revenus propres ?\n\n" +
    "<i>Constituent des revenus propres : un salaire, une pension ou une retraite, " +
    "ainsi que les revenus d'une activité commerciale, artisanale, libérale, agricole " +
    "ou d'une location. Un conjoint sans activité rémunérée est considéré à charge.</i>\n\n" +
    "<i>Un conjoint sans revenus ouvre droit à une demi-part supplémentaire, " +
    "mais double la TRIMF.</i>",
    [[{ text: 'Conjoint(e) SANS revenus', callback_data: 'C|1' }],
     [{ text: 'Conjoint(e) AVEC revenus', callback_data: 'C|0' }]]);
}

function demanderEnfants(chatId) {
  const b = (n) => ({ text: String(n), callback_data: 'E|' + n });
  return envoyer(chatId,
    "Combien d'enfants à charge avez-vous ?\n\n" +
    "<i>Sont considérés comme enfants à charge : les enfants mineurs, " +
    "les enfants infirmes, ainsi que les enfants âgés de moins de 25 ans " +
    "lorsqu'ils poursuivent leurs études.</i>",
    [[b(0), b(1), b(2), b(3)], [b(4), b(5), b(6), b(7)], [b(8), b(9), b(10)]]);
}

async function envoyerResultat(chatId, etat) {
  const r = liquider(etat.brut, etat.situation, etat.conjoint === true, etat.enfants);

  let famille = (etat.situation === 'marie') ? 'Marié(e)' : 'Célibataire';
  if (etat.situation === 'marie') {
    famille += etat.conjoint ? ', conjoint(e) sans revenus' : ', conjoint(e) avec revenus';
  }
  famille += ', ' + etat.enfants + (etat.enfants > 1 ? ' enfants' : ' enfant') + ' à charge';

  let t = '';
  t += "📊 <b>LIQUIDATION ANNUELLE — IR ET TRIMF</b>\n\n";

  t += "<b>1️⃣ Détermination du revenu net imposable</b>\n";
  t += "Salaire brut imposable : <b>" + fmt(r.brut) + "</b> F\n";
  t += "Abattement frais professionnels (30 %, plafond " + fmt(ABATTEMENT_PLAFOND) +
       ") : − " + fmt(r.abattement) + " F\n";
  t += "Revenu net imposable (arrondi au millier inférieur) : <b>" + fmt(r.net) + "</b> F\n\n";

  t += "<b>2️⃣ Situation de famille</b>\n";
  t += famille + "\n";
  t += "Nombre de parts : <b>" + String(r.parts).replace('.', ',') + "</b>";
  if (r.parts === PARTS_MAX) t += " (plafond légal atteint)";
  t += "\n\n";

  t += "<b>3️⃣ IR selon le barème progressif</b>\n";
  if (r.detail.length === 0) {
    t += "Revenu inférieur à " + fmt(630000) + " F : aucun impôt exigible.\n";
  } else {
    for (const d of r.detail) {
      const borne = (d.a === Infinity) ? "au-delà de " + fmt(d.de) : fmt(d.de) + " → " + fmt(d.a);
      t += "• " + borne + " : " + fmt(d.base) + " × " + pct(d.taux) +
           " = <b>" + fmt(d.montant) + "</b> F\n";
    }
  }
  t += "IR avant réduction : <b>" + fmt(r.irBareme) + "</b> F\n\n";

  t += "<b>4️⃣ Réduction pour charge de famille</b>\n";
  if (r.reduction.taux === 0) {
    t += "Aucune réduction (1 part).\n\n";
  } else {
    t += "Taux applicable : " + pct(r.reduction.taux) + " → " + fmt(r.reduction.theorique) + " F\n";
    t += "Encadrement : minimum " + fmt(r.reduction.min) + " / maximum " + fmt(r.reduction.max) + " F\n";
    t += "Réduction retenue : − <b>" + fmt(r.reduction.montant) + "</b> F\n\n";
  }

  t += "<b>5️⃣ Résultat</b>\n";
  t += "🔹 <b>IR annuel dû : " + fmt(r.irDu) + " F CFA</b>\n";
  t += "🔹 <b>TRIMF annuelle : " + fmt(r.trimf.total) + " F CFA</b>";
  if (r.trimf.double) t += " (" + fmt(r.trimf.base) + " × 2, conjoint à charge)";
  t += "\n";
  t += "🔸 <b>TOTAL IR + TRIMF : " + fmt(r.total) + " F CFA</b>\n";
  t += "Soit environ <b>" + fmt(r.total / 12) + " F par mois</b>.\n\n";

  t += "<i>Simulation indicative établie sur la base du barème en vigueur (CGI, art. 173 et " +
       "174) et d'une année complète de travail. Elle ne se substitue pas au calcul de " +
       "l'employeur ni à une décision de l'administration fiscale.</i>\n\n";
  t += ligneCompteur(await lireCompteurs()) + "\n\n";
  t += "🔁 Tapez /calcul pour une nouvelle simulation.";

  return envoyer(chatId, t);
}


/* ====================================================================================
   SERVEUR WEB
   ==================================================================================== */

const app = express();
app.use(express.json());

// Page d'etat (sert aussi a maintenir le service eveille).
app.get('/', (req, res) => res.status(200).send('Bot IR-TRIMF en ligne'));

// Point d'entree du webhook Telegram : repond 200 immediatement, sans redirection.
app.post('/webhook', (req, res) => {
  res.sendStatus(200);
  traiterUpdate(req.body).catch(err => console.error('Erreur traitement :', err));
});

app.listen(PORT, async () => {
  console.log('Bot IR-TRIMF demarre sur le port ' + PORT);
  await connecterBase();
  if (BASE_URL) {
    const r = await tg('setWebhook', {
      url: BASE_URL.replace(/\/$/, '') + '/webhook',
      drop_pending_updates: true
    });
    console.log('Webhook :', JSON.stringify(r));
  }
});

module.exports = { liquider };
