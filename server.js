const express = require('express');
const { Pool } = require('pg');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// Configure via environment variables. Example: PGUSER=postgres, PGDATABASE=gioco_societa
const pool = new Pool({
  user: process.env.PGUSER || 'postgres',
  host: process.env.PGHOST || 'localhost',
  database: process.env.PGDATABASE || 'gioco_societa',
  password: process.env.PGPASSWORD || '',
  port: Number(process.env.PGPORT || 5432),
});

const GROUPS = ['A', 'B', 'C', 'D', 'E'];
const BET = 5.00;
const roundTenth = (val) => Math.round((Number(val) + Number.EPSILON) * 10) / 10;
const toTenths = (val) => Math.round(Number(val) * 10);


function getLosingGroup(round) {
  const index = (GROUPS.length - (Number(round) % GROUPS.length)) % GROUPS.length;
  return GROUPS[index];
}


// Randomly adjusts array entries by 0.10 steps until the requested total is reached.
// The bounds are checked per entry; false means the target cannot be reached.
function adjustToTarget(values, targetTenths, minTenths, maxTenths) {
  let current = values.reduce((sum, v) => sum + toTenths(v), 0);
  let remaining = targetTenths - current;
  let guard = 0;
  while (remaining !== 0 && guard < 100000) {
    const increase = remaining > 0;
    const candidates = [];
    for (let i = 0; i < values.length; i++) {
      const v = toTenths(values[i]);
      if (increase ? v < maxTenths : v > minTenths) candidates.push(i);
    }
    if (!candidates.length) return false;
    const idx = candidates[Math.floor(Math.random() * candidates.length)];
    values[idx] = (toTenths(values[idx]) + (increase ? 1 : -1)) / 10;
    remaining += increase ? -1 : 1;
    guard++;
  }
  return remaining === 0;
}


async function generateRoundInDB(client, sessionId, roundNumber, reserveFund, initialAdvance) {
  const losingGroup = getLosingGroup(roundNumber);
  let recoveryTarget = 0;
  if (roundNumber >= 6 && roundNumber <= 12 && reserveFund < initialAdvance) {
    const remainingRounds = 13 - roundNumber;
    recoveryTarget = roundTenth((initialAdvance - reserveFund) / remainingRounds);
  }

  const totalCollected = 100 * BET; // 500.00
  // With payout ranges below, total payout must be at least 20*3.20 + 80*5.10 = 472.
  const minPayout = 20 * 3.20 + 80 * 5.10;
  const maxPayout = 20 * 4.80 + 80 * 5.90;
  const desiredPayout = totalCollected - recoveryTarget;
  const targetPayout = roundTenth(Math.min(maxPayout, Math.max(minPayout, desiredPayout)));

  // 20 losing seats: range 3.20–4.80; start randomized within 3.80–4.80.
  const losers = Array.from({ length: 20 }, () => roundTenth(3.80 + Math.floor(Math.random() * 11) * 0.10));
  // 80 winning seats: start at 5.10, then adjust the combined total to the target.
  const winners = new Array(80).fill(5.10);
  const baseTotalTenths = losers.reduce((sum, v) => sum + toTenths(v), 0)
    + winners.reduce((sum, v) => sum + toTenths(v), 0);
  const targetTenths = toTenths(targetPayout);

  // First adjust the winning pool up to its cap; if the target is below baseline,
  // lower losing seats first, then winning seats if necessary. All amounts remain in 0.10 steps.
  const winnerSumTenths = () => winners.reduce((sum, v) => sum + toTenths(v), 0);
  const loserSumTenths = () => losers.reduce((sum, v) => sum + toTenths(v), 0);
  if (targetTenths >= baseTotalTenths) {
    const desiredWinnerTotal = Math.min(80 * 59, Math.max(80 * 51, targetTenths - loserSumTenths()));
    if (!adjustToTarget(winners, desiredWinnerTotal, 51, 59)) {
      throw new Error('Impossibile distribuire il totale vincite richiesto entro i limiti configurati.');
    }
    const desiredLoserTotal = targetTenths - winnerSumTenths();
    if (!adjustToTarget(losers, desiredLoserTotal, 32, 48)) {
      throw new Error('Impossibile distribuire il totale vincite richiesto entro i limiti configurati.');
    }
  } else {
    const desiredLoserTotal = Math.min(20 * 48, Math.max(20 * 32, targetTenths - winnerSumTenths()));
    if (!adjustToTarget(losers, desiredLoserTotal, 32, 48)) {
      throw new Error('Impossibile distribuire il totale vincite richiesto entro i limiti configurati.');
    }
    const desiredWinnerTotal = targetTenths - loserSumTenths();
    if (!adjustToTarget(winners, desiredWinnerTotal, 51, 59)) {
      throw new Error('Impossibile distribuire il totale vincite richiesto entro i limiti configurati.');
    }
  }


  // Shuffle each payout pool to avoid a fixed ordering pattern in the seats.
  winners.sort(() => Math.random() - 0.5);
  losers.sort(() => Math.random() - 0.5);


  let wIdx = 0;
  let lIdx = 0;
  for (let i = 0; i < 100; i++) {
    const seatNum = i + 1;
    const group = GROUPS[Math.floor(i / 20)];
    const amount = group === losingGroup ? losers[lIdx++] : winners[wIdx++];
    await client.query(
      `INSERT INTO giocate_coperti (sessione_id, numero_mano, numero_posto, gruppo, puntata, vincita_assegnata)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [sessionId, roundNumber, seatNum, group, BET, amount]
    );
  }

  const actualPaid = roundTenth(losers.reduce((a, b) => a + b, 0) + winners.reduce((a, b) => a + b, 0));
  const recoveredNow = roundTenth(totalCollected - actualPaid);
  if (recoveredNow > 0) {
    const newReserve = roundTenth(reserveFund + recoveredNow);
    await client.query(
      `UPDATE sessioni_gioco SET cassa_compensazione = $1 WHERE id = $2`,
      [newReserve, sessionId]
    );
    await client.query(
      `INSERT INTO movimenti_cassa (sessione_id, numero_mano, tipo_movimento, importo, saldo_cassa_dopo, note)
       VALUES ($1, $2, 'recupero_amm', $3, $4, 'Recupero automatico quota gestore')`,
      [sessionId, roundNumber, recoveredNow, newReserve]
    );
  }
}


// ============================================================================
// API PUBBLICHE (GIOCATORI)
// ============================================================================
app.get('/api/tavolo/:sessioneId', async (req, res) => {
  try {
    const { sessioneId } = req.params;
    const sessRes = await pool.query(
      `SELECT id, nome_tavolo, mano_corrente, stato FROM sessioni_gioco WHERE id = $1`,
      [sessioneId]
    );
    if (sessRes.rows.length === 0) return res.status(404).json({ error: 'Sessione non trovata' });
    const sessione = sessRes.rows[0];
    const seatsRes = await pool.query(
      `SELECT numero_posto, gruppo, scoperto,
              CASE WHEN scoperto = TRUE THEN vincita_assegnata ELSE NULL END AS vincita
       FROM giocate_coperti
       WHERE sessione_id = $1 AND numero_mano = $2
       ORDER BY numero_posto ASC`,
      [sessioneId, sessione.mano_corrente]
    );
    res.json({ sessione, posti: seatsRes.rows });
  } catch (err) {
    console.error('Errore GET /api/tavolo:', err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});


app.post('/api/gioca', async (req, res) => {
  const { sessioneId, numeroPosto, utenteId } = req.body || {};
  if (!sessioneId || !utenteId || !Number.isInteger(Number(numeroPosto)) || Number(numeroPosto) < 1 || Number(numeroPosto) > 100) {
    return res.status(400).json({ error: 'Parametri di giocata non validi' });
  }
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const sessRes = await client.query(`SELECT mano_corrente FROM sessioni_gioco WHERE id = $1 FOR UPDATE`, [sessioneId]);
    if (!sessRes.rows.length) {
      await client.query('ROLLBACK');
      return res.status(404).json({ error: 'Sessione non trovata' });
    }
    const mano = sessRes.rows[0].mano_corrente;
    const seatRes = await client.query(
      `SELECT id, vincita_assegnata, scoperto FROM giocate_coperti
       WHERE sessione_id = $1 AND numero_mano = $2 AND numero_posto = $3 FOR UPDATE`,
      [sessioneId, mano, Number(numeroPosto)]
    );
    const posto = seatRes.rows[0];
    if (!posto || posto.scoperto) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Coperchio già aperto o non valido' });
    }
    const userRes = await client.query(`SELECT saldo_gettoni FROM utenti WHERE id = $1 FOR UPDATE`, [utenteId]);
    if (!userRes.rows.length) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Utente non trovato' });
    }
    const saldoAttuale = Number(userRes.rows[0].saldo_gettoni);
    if (!Number.isFinite(saldoAttuale) || saldoAttuale < BET) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(400).json({ error: 'Gettoni insufficienti (servono 5 gettoni)' });
    }
    const vincita = Number(posto.vincita_assegnata);
    if (!Number.isFinite(vincita)) throw new Error('Importo vincita non valido nel database');
    const nuovoSaldo = roundTenth(saldoAttuale - BET + vincita);
    await client.query(`UPDATE utenti SET saldo_gettoni = $1 WHERE id = $2`, [nuovoSaldo, utenteId]);
    await client.query(
      `UPDATE giocate_coperti SET utente_id = $1, scoperto = TRUE, scoperto_il = NOW() WHERE id = $2`,
      [utenteId, posto.id]
    );
    await client.query(
      `INSERT INTO transazioni_gettoni (utente_id, sessione_id, tipo, importo, saldo_risultante)
       VALUES ($1, $2, 'puntata', -5.00, $3), ($1, $2, 'vincita', $4, $5)`,
      [utenteId, sessioneId, roundTenth(saldoAttuale - BET), vincita, nuovoSaldo]
    );
    await client.query('COMMIT');
    transactionStarted = false;
    res.json({ success: true, numeroPosto: Number(numeroPosto), vincita, nuovoSaldo });
  } catch (err) {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Errore rollback:', rollbackErr); }
    }
    console.error('Errore POST /api/gioca:', err);
    res.status(500).json({ error: 'Errore durante la giocata' });
  } finally {
    client.release();
  }
});


// ============================================================================
// API RISERVATE AL GESTORE
// ============================================================================
const ADMIN_KEY = process.env.ADMIN_KEY;
function checkAdmin(req, res, next) {
  if (!ADMIN_KEY || req.headers['x-admin-key'] !== ADMIN_KEY) {
    return res.status(403).json({ error: 'Accesso riservato al gestore' });
  }
  next();
}


app.get('/api/admin/stato/:sessioneId', checkAdmin, async (req, res) => {
  try {
    const sess = await pool.query(`SELECT * FROM sessioni_gioco WHERE id = $1`, [req.params.sessioneId]);
    if (!sess.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    const s = sess.rows[0];
    res.json({
      mano_corrente: s.mano_corrente,
      cassa_compensazione: s.cassa_compensazione,
      anticipo_iniziale: s.anticipo_gestore_iniziale,
      gruppo_penalizzato: getLosingGroup(s.mano_corrente)
    });
  } catch (err) {
    console.error('Errore GET admin/stato:', err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});


app.post('/api/admin/rivela-tutti/:sessioneId', checkAdmin, async (req, res) => {
  try {
    const { sessioneId } = req.params;
    const sess = await pool.query(`SELECT mano_corrente FROM sessioni_gioco WHERE id = $1`, [sessioneId]);
    if (!sess.rows.length) return res.status(404).json({ error: 'Sessione non trovata' });
    await pool.query(
      `UPDATE giocate_coperti SET scoperto = TRUE, scoperto_il = NOW()
       WHERE sessione_id = $1 AND numero_mano = $2`,
      [sessioneId, sess.rows[0].mano_corrente]
    );
    res.json({ success: true, message: 'Tutti i coperchi rivelati' });
  } catch (err) {
    console.error('Errore admin/rivela-tutti:', err);
    res.status(500).json({ error: 'Errore interno del server' });
  }
});


app.post('/api/admin/prossima-mano/:sessioneId', checkAdmin, async (req, res) => {
  const { sessioneId } = req.params;
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const sess = await client.query(`SELECT * FROM sessioni_gioco WHERE id = $1 FOR UPDATE`, [sessioneId]);
    if (!sess.rows.length) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Sessione non trovata' });
    }
    const s = sess.rows[0];
    const nextRound = Number(s.mano_corrente) + 1;
    await client.query(`UPDATE sessioni_gioco SET mano_corrente = $1 WHERE id = $2`, [nextRound, sessioneId]);
    await generateRoundInDB(client, sessioneId, nextRound, Number(s.cassa_compensazione), Number(s.anticipo_gestore_iniziale));
    await client.query('COMMIT');
    transactionStarted = false;
    res.json({ success: true, nuovaMano: nextRound });
  } catch (err) {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Errore rollback:', rollbackErr); }
    }
    console.error('Errore admin/prossima-mano:', err);
    res.status(500).json({ error: 'Errore durante la creazione della mano' });
  } finally {
    client.release();
  }
});


app.post('/api/admin/ricomincia/:sessioneId', checkAdmin, async (req, res) => {
  const { sessioneId } = req.params;
  const client = await pool.connect();
  let transactionStarted = false;
  try {
    await client.query('BEGIN');
    transactionStarted = true;
    const sess = await client.query(`SELECT id FROM sessioni_gioco WHERE id = $1 FOR UPDATE`, [sessioneId]);
    if (!sess.rows.length) {
      await client.query('ROLLBACK');
      transactionStarted = false;
      return res.status(404).json({ error: 'Sessione non trovata' });
    }
    await client.query(`DELETE FROM giocate_coperti WHERE sessione_id = $1`, [sessioneId]);
    await client.query(
      `UPDATE sessioni_gioco
       SET mano_corrente = 1, cassa_compensazione = 40.00, anticipo_gestore_iniziale = 40.00
       WHERE id = $1`,
      [sessioneId]
    );
    await client.query(
      `INSERT INTO movimenti_cassa
       (sessione_id, numero_mano, tipo_movimento, importo, saldo_cassa_dopo, note)
       VALUES ($1, 1, 'anticipo_gestore', 40.00, 40.00, 'Nuova sessione avviata dal gestore')`,
      [sessioneId]
    );
    await generateRoundInDB(client, sessioneId, 1, 40.00, 40.00);
    await client.query('COMMIT');
    transactionStarted = false;
    res.json({ success: true, message: 'Sessione riavviata' });
  } catch (err) {
    if (transactionStarted) {
      try { await client.query('ROLLBACK'); } catch (rollbackErr) { console.error('Errore rollback:', rollbackErr); }
    }
    console.error('Errore admin/ricomincia:', err);
    res.status(500).json({ error: 'Errore durante il riavvio della sessione' });
  } finally {
    client.release();
  }
});


app.listen(Number(process.env.PORT || 3000), () => {
  console.log(`🚀 Server VINCI in ascolto su http://localhost:${process.env.PORT || 3000}`);
});
