/**
 * Controle du moteur de calcul sur 11 dossiers reels extraits de la feuille BCTX.
 * Lancement : node test.js
 */
const { liquider } = require('./index.js');

const cas = [
  [5497607,  'marie', true,  0, 2,   4597000,  1132950, 200000,  932950,  24000],
  [4761553,  'marie', true,  3, 3.5, 3861000,  882300,  500000,  382300,  24000],
  [15502407, 'marie', true,  0, 2,   14602000, 4799800, 650000,  4149800, 72000],
  [2243029,  'marie', false, 2, 2.5, 1570000,  195000,  300000,  0,       12000],
  [25366499, 'marie', false, 3, 3,   24466000, 8745400, 1650000, 7095400, 36000],
  [3900473,  'marie', false, 2, 2.5, 3000000,  624000,  300000,  324000,  12000],
  [5952483,  'celib', false, 0, 1,   5052000,  1292200, 0,       1292200, 12000],
  [14135859, 'marie', false, 0, 1.5, 13235000, 4260950, 300000,  3960950, 36000],
  [10944430, 'marie', false, 3, 3,   10044000, 3080280, 770070,  2310210, 18000],
  [11740991, 'marie', false, 4, 3.5, 10840000, 3374800, 1012440, 2362360, 18000],
  [5168107,  'marie', false, 2, 2.5, 4268000,  1017800, 300000,  717800,  12000]
];

let ok = 0;
for (const c of cas) {
  const r = liquider(c[0], c[1], c[2], c[3]);
  const bon = r.parts === c[4] && r.net === c[5] && r.irBareme === c[6] &&
              r.reduction.montant === c[7] && r.irDu === c[8] && r.trimf.total === c[9];
  if (bon) ok++;
  console.log((bon ? 'OK    ' : 'ECHEC ') + 'brut ' + c[0] +
    ' | parts ' + r.parts + ' | net ' + r.net + ' | IR ' + r.irBareme +
    ' | reduction ' + r.reduction.montant + ' | IR du ' + r.irDu + ' | TRIMF ' + r.trimf.total);
}
console.log(ok + '/' + cas.length + ' cas conformes');
process.exit(ok === cas.length ? 0 : 1);
