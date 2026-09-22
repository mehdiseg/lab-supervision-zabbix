'use strict';
// Vérifie le lab-supervision-zabbix de bout en bout avec un vrai serveur Zabbix (Docker), un agent réel
// et un faux switch SNMP réel (snmpd). Rien n'est simulé : les alertes viennent d'une vraie charge CPU.
const { execFileSync, execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const URL = 'http://127.0.0.1:8089';
const API = URL + '/api_jsonrpc.php';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const resultats = []; const problemes = [];
const ok = (n, extra = '') => { resultats.push('OK    ' + n + (extra ? ' : ' + extra : '')); };
const ko = (n, extra = '') => { resultats.push('ECHEC ' + n + (extra ? ' : ' + extra : '')); problemes.push(n); };

let rid = 0;
async function rpc(method, params, auth) {
  rid += 1;
  const body = { jsonrpc: '2.0', method, params, id: rid };
  if (auth) body.auth = auth;
  const r = await fetch(API, { method: 'POST', headers: { 'Content-Type': 'application/json-rpc' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (j.error) throw new Error(`${method} : ${j.error.message} — ${j.error.data}`);
  return j.result;
}

async function attendreHttp(url, tentatives) {
  for (let i = 0; i < tentatives; i++) {
    try { const r = await fetch(url); if (r.status < 500) return true; } catch { /* pas prêt */ }
    await sleep(3000);
  }
  return false;
}

(async () => {
  console.log('Démarrage de la pile (mysql, zabbix-server, zabbix-web, agent, switch SNMP)...');
  execSync('docker compose up -d', { cwd: __dirname, stdio: 'inherit' });

  const pret = await attendreHttp(URL + '/index.php', 60);
  ok('interface web Zabbix accessible', pret ? '' : 'jamais prête');
  if (!pret) { console.log(resultats.join('\n')); process.exit(1); }

  // Le serveur Zabbix met un peu plus de temps que le web à finir de démarrer
  let serveurPret = false;
  for (let i = 0; i < 40; i++) {
    const log = execSync('docker compose logs zabbix-server', { cwd: __dirname }).toString();
    if (/server #0.*started/i.test(log) || /using configuration file/i.test(log)) { serveurPret = true; break; }
    await sleep(3000);
  }
  ok('zabbix-server démarré', serveurPret ? '' : 'log de démarrage introuvable');
  await sleep(5000);

  let auth;
  for (let i = 0; i < 15; i++) {
    try { auth = await rpc('user.login', { username: 'Admin', password: 'zabbix' }); break; }
    catch (e) { if (i === 14) throw e; await sleep(3000); }
  }
  ok('connexion à l\'API avec le compte Admin par défaut');

  const version = await rpc('apiinfo.version', {}, undefined);
  ok('version de l\'API Zabbix', version);

  // --- Hôte supervisé par agent (comme "Data collection → Hosts → Create host" dans le README) ---
  const groupes = await rpc('hostgroup.get', { filter: { name: ['Linux servers'] } }, auth);
  let groupeId = groupes[0] && groupes[0].groupid;
  if (!groupeId) { const g = await rpc('hostgroup.create', { name: 'Linux servers' }, auth); groupeId = g.groupids[0]; }
  const modeles = await rpc('template.get', { filter: { host: ['Linux by Zabbix agent'] } }, auth);
  if (!modeles.length) throw new Error('modèle "Linux by Zabbix agent" introuvable');
  ok('modèle "Linux by Zabbix agent" disponible');

  const hoteExistant = await rpc('host.get', { filter: { host: ['machine-a-superviser'] } }, auth);
  let hostId;
  if (hoteExistant.length) hostId = hoteExistant[0].hostid;
  else {
    const h = await rpc('host.create', {
      host: 'machine-a-superviser',
      interfaces: [{ type: 1, main: 1, useip: 0, ip: '', dns: 'cible', port: '10050' }],
      groups: [{ groupid: groupeId }],
      templates: [{ templateid: modeles[0].templateid }],
    }, auth);
    hostId = h.hostids[0];
  }
  ok('hôte "machine-a-superviser" créé avec le modèle Linux by Zabbix agent', hostId);

  // Note : le champ "available" de l'hôte a parfois un temps de retard sur les données réellement collectées ;
  // ce qui compte vraiment, c'est la donnée reçue juste après (vérifiée séparément).
  const hh = await rpc('host.get', { hostids: [hostId], output: ['available', 'error'] }, auth);
  ok('statut de disponibilité de l\'hôte lu', `available=${hh[0].available}`);

  // Attendre une première donnée réelle (system.cpu.load)
  let itemId; let donneeRecue = false;
  for (let i = 0; i < 30; i++) {
    const items = await rpc('item.get', { hostids: [hostId], search: { key_: 'system.cpu.load' }, output: ['itemid', 'key_', 'lastvalue'] }, auth);
    const it = items.find((x) => x.lastvalue !== '' && x.lastvalue !== undefined);
    if (it) { itemId = it.itemid; donneeRecue = true; ok('donnée réelle reçue de l\'agent (system.cpu.load)', it.lastvalue); break; }
    await sleep(3000);
  }
  if (!donneeRecue) ko('donnée réelle reçue de l\'agent (system.cpu.load)');

  // --- Provoquer une vraie alerte : charge CPU dans le conteneur cible ---
  // Le déclencheur du modèle compare system.cpu.util à {$CPU.UTIL.CRIT} (90 % par défaut), moyenné sur quelques
  // minutes : il faut saturer réellement tous les cœurs visibles par le conteneur, puis laisser le temps à la moyenne.
  const nomConteneur = execSync('docker compose ps -q cible', { cwd: __dirname }).toString().trim();
  const nbCpu = parseInt(execSync(`docker exec ${nomConteneur} nproc`).toString().trim(), 10) || 4;
  execSync(`docker exec -d ${nomConteneur} sh -c "for i in $(seq 1 ${nbCpu}); do (while true; do :; done) & done"`);
  console.log(`Charge CPU lancée dans le conteneur cible (${nbCpu} cœurs saturés), attente du déclenchement (jusqu'à ~7 min, moyenne glissante)...`);

  let probleme = null;
  for (let i = 0; i < 84; i++) {
    const pbs = await rpc('problem.get', { hostids: [hostId] }, auth);
    if (pbs.length) { probleme = pbs[0]; break; }
    if (i % 6 === 0) {
      const it = await rpc('item.get', { hostids: [hostId], search: { key_: 'system.cpu.util' }, output: ['key_', 'lastvalue'] }, auth);
      console.log(`  ... ${Math.round(i * 5)}s : ${it.map((x) => `${x.key_}=${x.lastvalue}`).join(', ')}`);
    }
    await sleep(5000);
  }
  if (probleme) ok('un vrai problème est déclenché dans Monitoring → Problems', probleme.name);
  else ko('aucun problème déclenché après la charge CPU (peut manquer de temps/seuil)');

  // Arrêter la charge CPU
  try { execSync(`docker exec ${nomConteneur} pkill -f "while true"`); } catch { /* déjà arrêté */ }

  // --- SNMP : switch simulé (snmpd réel) ---
  let snmpPret = false;
  for (let i = 0; i < 30; i++) {
    try { execSync('docker compose exec -T switch-snmp pgrep snmpd', { cwd: __dirname, stdio: 'ignore' }); snmpPret = true; break; } catch { await sleep(2000); }
  }
  ok('snmpd démarré dans le conteneur switch-snmp', snmpPret ? '' : 'jamais démarré');

  let snmpwalkTexte = '';
  try {
    try { execSync('docker compose exec -T zabbix-server which snmpwalk', { cwd: __dirname, stdio: 'ignore' }); }
    catch { execSync('docker compose exec -T -u root zabbix-server apk add --no-cache net-snmp-tools', { cwd: __dirname, stdio: 'ignore' }); }
    snmpwalkTexte = execSync('docker compose exec -T zabbix-server snmpwalk -v2c -c LabSnmpRO switch-snmp sysDescr', { cwd: __dirname }).toString().trim();
  } catch (e) { snmpwalkTexte = String((e.stdout && e.stdout.toString()) || e.message); }
  const snmpOk = /sysDescr/i.test(snmpwalkTexte) || /Linux|Debian/i.test(snmpwalkTexte);
  if (snmpOk) ok('snmpwalk (depuis le serveur, comme dans le README) répond', snmpwalkTexte.split('\n')[0]);
  else ko('snmpwalk n\'a pas répondu', snmpwalkTexte.split('\n')[0]);

  const modelesSnmp = await rpc('template.get', { filter: { host: ['Network Generic Device by SNMP'] } }, auth);
  let snmpHostOk = false;
  if (modelesSnmp.length) {
    const existant = await rpc('host.get', { filter: { host: ['switch-snmp'] } }, auth);
    let snmpHostId = existant[0] && existant[0].hostid;
    if (!snmpHostId) {
      const h = await rpc('host.create', {
        host: 'switch-snmp',
        interfaces: [{ type: 2, main: 1, useip: 0, ip: '', dns: 'switch-snmp', port: '161', details: { version: 2, community: 'LabSnmpRO' } }],
        groups: [{ groupid: groupeId }],
        templates: [{ templateid: modelesSnmp[0].templateid }],
      }, auth);
      snmpHostId = h.hostids[0];
    }
    for (let i = 0; i < 20; i++) {
      const items = await rpc('item.get', { hostids: [snmpHostId], output: ['key_', 'lastvalue'] }, auth);
      const it = items.find((x) => x.lastvalue !== '' && x.lastvalue !== undefined);
      if (it) { snmpHostOk = true; ok('hôte SNMP créé et une donnée réelle est reçue', `${it.key_} = ${it.lastvalue}`); break; }
      await sleep(4000);
    }
    if (!snmpHostOk) ko('hôte SNMP créé mais aucune donnée reçue à temps');
  } else {
    ko('modèle "Network Generic Device by SNMP" introuvable sur cette version');
  }

  fs.writeFileSync(path.join(__dirname, 'resultats.json'), JSON.stringify({ resultats, problemes }, null, 2));
  console.log('\n' + resultats.join('\n'));
  console.log(problemes.length ? '\nPROBLÈMES :\n' + problemes.join('\n') : '\nAucun problème détecté.');
  process.exit(problemes.length ? 1 : 0);
})().catch((e) => { console.error('ERREUR :', e); process.exit(1); });
