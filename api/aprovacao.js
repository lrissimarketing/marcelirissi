// Pulsa Lab · API de aprovação de conteúdo
// Função da Vercel (Node). Liga os botões da página de aprovação ao ClickUp.
//
// Variáveis de ambiente do projeto na Vercel:
//   CLICKUP_TOKEN    token pessoal da API do ClickUp (Settings → Apps). Secreto: cadastrar como "Sensitive".
//   CLICKUP_LIST_ID  ID da lista do cliente no ClickUp (vários: separados por vírgula). Só tarefas dessas listas são aceitas.
//
// GET  /api/aprovacao?ids=ID1,ID2  → { estados: { ID1: 'aguardando' | 'aprovado' | 'ajuste' | 'agendado' | 'postado' | 'em-producao' } }
// POST /api/aprovacao  { id, acao: 'aprovar' | 'ajuste', texto }  → { ok: true, estado }

const API = 'https://api.clickup.com/api/v2';
const TAG_OK = 'aprovado-cliente';
const TAG_AJUSTE = 'ajuste-cliente';
const ST_AGUARDANDO = 'aguardando aprovação';
const ST_AJUSTE = 'em progresso';
const ID_OK = /^[a-z0-9]{4,20}$/i;

const norm = (s) => String(s || '').normalize('NFC').trim().toLowerCase();

async function cu(path, opts = {}) {
  const r = await fetch(API + path, {
    ...opts,
    headers: { Authorization: process.env.CLICKUP_TOKEN, 'Content-Type': 'application/json', ...(opts.headers || {}) },
  });
  const txt = await r.text();
  let body = null;
  try { body = txt ? JSON.parse(txt) : null; } catch (_) { body = txt; }
  if (!r.ok) {
    const e = new Error('ClickUp ' + r.status);
    e.status = r.status; e.body = body;
    throw e;
  }
  return body;
}

function listasPermitidas() {
  return String(process.env.CLICKUP_LIST_ID || '').split(',').map((s) => s.trim()).filter(Boolean);
}

async function lerTarefa(id) {
  const t = await cu('/task/' + encodeURIComponent(id));
  const listas = listasPermitidas();
  if (!t || !t.list || !listas.includes(String(t.list.id))) {
    const e = new Error('Tarefa fora da lista do cliente'); e.status = 404; throw e;
  }
  return t;
}

function estadoDe(t) {
  const st = norm(t.status && t.status.status);
  const tags = (t.tags || []).map((x) => norm(x.name));
  if (st === 'postado') return 'postado';
  if (st === 'agendado') return 'agendado';
  if (tags.includes(TAG_AJUSTE)) return 'ajuste';
  if (st === norm(ST_AGUARDANDO)) return tags.includes(TAG_OK) ? 'aprovado' : 'aguardando';
  return 'em-producao';
}

function agoraBR() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}

async function lerCorpo(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') { try { return JSON.parse(req.body); } catch (_) { return {}; } }
  const chunks = [];
  for await (const c of req) chunks.push(c);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'); } catch (_) { return {}; }
}

function json(res, status, obj) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(obj));
}

module.exports = async function handler(req, res) {
  if (!process.env.CLICKUP_TOKEN || !listasPermitidas().length) {
    return json(res, 503, { ok: false, erro: 'Aprovação ainda não configurada.' });
  }
  try {
    if (req.method === 'GET') {
      const url = new URL(req.url, 'http://x');
      const ids = String(url.searchParams.get('ids') || '').split(',').map((s) => s.trim()).filter((s) => ID_OK.test(s)).slice(0, 40);
      const estados = {};
      await Promise.all(ids.map(async (id) => {
        try { estados[id] = estadoDe(await lerTarefa(id)); } catch (_) { estados[id] = null; }
      }));
      return json(res, 200, { ok: true, estados });
    }

    if (req.method === 'POST') {
      const b = await lerCorpo(req);
      const id = String(b.id || '');
      const acao = String(b.acao || '');
      const texto = String(b.texto || '').trim().slice(0, 2000);
      if (!ID_OK.test(id) || !['aprovar', 'ajuste'].includes(acao)) return json(res, 400, { ok: false, erro: 'Pedido inválido.' });
      if (acao === 'ajuste' && !texto) return json(res, 400, { ok: false, erro: 'Conte o que precisa mudar.' });

      const t = await lerTarefa(id);
      const atual = estadoDe(t);
      if (atual === 'agendado' || atual === 'postado') return json(res, 409, { ok: false, estado: atual, erro: 'Este post já foi agendado. Fale com a Pulsa Lab para mudar.' });
      if (atual === 'em-producao') return json(res, 409, { ok: false, estado: atual, erro: 'Este post ainda está em produção.' });

      const tag = (nome) => '/task/' + encodeURIComponent(id) + '/tag/' + encodeURIComponent(nome);
      const has = (nome) => (t.tags || []).some((x) => norm(x.name) === nome);

      if (acao === 'aprovar') {
        if (atual === 'ajuste') return json(res, 409, { ok: false, estado: atual, erro: 'O ajuste pedido ainda está sendo feito.' });
        if (atual !== 'aprovado') {
          await cu(tag(TAG_OK), { method: 'POST', body: '{}' });
          await cu('/task/' + encodeURIComponent(id) + '/comment', {
            method: 'POST',
            body: JSON.stringify({ comment_text: '✅ Aprovado pelo cliente na página de aprovação (' + agoraBR() + ').', notify_all: true }),
          });
        }
        return json(res, 200, { ok: true, estado: 'aprovado' });
      }

      // ajuste
      if (has(TAG_OK)) await cu(tag(TAG_OK), { method: 'DELETE' });
      if (!has(TAG_AJUSTE)) await cu(tag(TAG_AJUSTE), { method: 'POST', body: '{}' });
      await cu('/task/' + encodeURIComponent(id), { method: 'PUT', body: JSON.stringify({ status: ST_AJUSTE }) });
      await cu('/task/' + encodeURIComponent(id) + '/comment', {
        method: 'POST',
        body: JSON.stringify({ comment_text: '✏️ Ajuste pedido pelo cliente na página de aprovação (' + agoraBR() + '):\n\n' + texto, notify_all: true }),
      });
      return json(res, 200, { ok: true, estado: 'ajuste' });
    }

    res.setHeader('Allow', 'GET, POST');
    return json(res, 405, { ok: false, erro: 'Método não permitido.' });
  } catch (e) {
    const status = e.status === 404 ? 404 : 502;
    return json(res, status, { ok: false, erro: status === 404 ? 'Post não encontrado.' : 'Não foi possível falar com o ClickUp agora. Tente de novo em instantes.' });
  }
};
