// 订阅模型：管道识别、上游渠道枚举、有序钉住链、探测 / 测试 / 全渠道校验
(function () {
  'use strict';

  let models = [];       // /api/models 的 subscription
  let perModel = {};     // /api/config 的 perModel
  let busy = {};         // modelId -> 正在进行的动作名
  let onlyProbed = false;

  async function fetchAll() {
    const [m, c] = await Promise.all([API.models(), API.config()]);
    models = m.subscription || [];
    perModel = c.perModel || {};
    return { meta: m, cfg: c };
  }

  function cfgOf(id) {
    return Object.assign({ upstreams: [], exclude: [], pinMode: 'strict', sort: null, has: [] }, perModel[id] || {});
  }

  // 能力过滤（providerOptions.gateway.has）：实测只有带上它，规划器管道上的 only 才会被执行。
  // 这两个是 2026-10-23 实测用的标签；输入框可以再补其它标签。
  const KNOWN_HAS = ['vision', 'implicit-caching'];
  // 只对实测过的那一类（DeepSeek v4.1-flash / vision 变体）预勾选。
  // 纯文本模型带上 vision 会一个上游都匹配不到；只带 implicit-caching 又没实测证据，
  // 所以不预勾选，让用户自己试并先用两组请求验证。
  function suggestedHas(modelId) {
    if (!/deepseek/i.test(modelId)) return [];
    return /v4\.1-flash|vision/i.test(modelId) ? KNOWN_HAS.slice() : [];
  }

  async function load(root) {
    root.innerHTML = '<div class="empty">加载中…</div>';
    try {
      await fetchAll();
    } catch (e) {
      root.innerHTML = '<div class="banner b-critical"><span class="b-ico">⚠</span><div>读取失败：' + U.esc(e.message) + '</div></div>';
      return;
    }
    render(root);
  }

  function render(root) {
    const list = onlyProbed ? models.filter((m) => m.meta && m.meta.pipeline) : models;
    root.innerHTML = [
      renderToolbar(),
      renderTable(list),
      renderLegend(),
    ].join('');
  }

  function renderToolbar() {
    return '<div class="card tight"><div class="row-gap">' +
      '<label class="switch"><input type="checkbox" data-act="only-probed" ' + (onlyProbed ? 'checked' : '') + '><span class="track"></span><span class="switch-label">只看已探测</span></label>' +
      '<span class="spacer"></span>' +
      '<button class="btn btn-sm" data-act="probe-all">探测全部</button>' +
      '<button class="btn btn-sm" data-act="validate-all">校验全部渠道</button>' +
      '<button class="btn btn-sm" data-act="fetch-official">拉取官方最新模型</button>' +
      '</div>' +
      '<div class="card-note" style="margin-top:8px">探测：识别模型走哪条管道并枚举可用渠道（极小额真实请求）。校验：把每个渠道各钉一次，实测可用性（渠道多时耗时较久）。</div>' +
    '</div>';
  }

  function renderTable(list) {
    if (!list.length) return U.empty('没有模型');
    const rows = list.map((m) => {
      const meta = m.meta || {};
      const cfg = cfgOf(m.id);
      const ups = meta.upstreams || [];
      const status = meta.upstreamStatus || {};
      const busyName = busy[m.id];
      const actual = meta.provider || meta.lastProvider;
      const latMs = meta.ms || meta.lastMs;

      return '<tr data-model="' + U.esc(m.id) + '">' +
        '<td><div class="mono ellip" title="' + U.esc(m.id) + '">' + U.esc(m.id) + '</div>' +
          (meta.canonicalSlug ? '<div class="muted mono" style="font-size:11px">↳ ' + U.esc(meta.canonicalSlug) + '</div>' : '') + '</td>' +
        '<td>' + U.pipelineBadge(meta.pipeline) + '</td>' +
        '<td>' + renderChain(cfg, ups) + '</td>' +
        '<td>' + (actual
            ? '<span class="mono ellip-block" title="' + U.esc(actual) + '">' + U.esc(actual) + '</span>'
            : '<span class="muted">—</span>') +
          (latMs ? '<div class="muted" style="font-size:11px">' + U.fmtMs(latMs) + '</div>' : '') + '</td>' +
        '<td>' + U.esc(U.pinModeLabel(cfg.pinMode)) +
          (cfg.sort ? '<div class="muted" style="font-size:11px">' + U.esc(U.sortLabel(cfg.sort)) + '</div>' : '') +
          ((cfg.has && cfg.has.length) ? '<div class="muted" style="font-size:11px">能力过滤：' + U.esc(cfg.has.join(', ')) + '</div>' : '') +
          ((meta.pipeline === 'planner' && (cfg.upstreams || []).length && !(cfg.has || []).length)
            ? '<div style="font-size:11px;color:var(--warning)">钉住可能被忽略（未启用能力过滤）</div>' : '') +
        '</td>' +
        '<td><div class="row-gap tight">' +
          '<button class="btn btn-sm" data-act="chain" title="配置钉住链（探测不到渠道时可手动添加）">渠道' + (ups.length ? ' (' + ups.length + ')' : '') + '</button>' +
          '<button class="btn btn-sm" data-act="probe" ' + (busyName ? 'disabled' : '') + '>' + (busyName === 'probe' ? '探测中…' : '探测') + '</button>' +
          '<button class="btn btn-sm" data-act="test" ' + (busyName ? 'disabled' : '') + '>' + (busyName === 'test' ? '测试中…' : '测试') + '</button>' +
          '<button class="btn btn-sm" data-act="validate" ' + (busyName || !ups.length ? 'disabled' : '') + '>' + (busyName === 'validate' ? '校验中…' : '校验') + '</button>' +
        '</div></td>' +
      '</tr>';
    }).join('');

    return '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
      '<thead><tr><th style="min-width:200px">模型</th><th style="width:88px">管道</th><th style="min-width:230px">钉住链（按序回退）</th>' +
      '<th style="width:150px">最近实际渠道</th><th style="width:110px">模式</th><th style="width:290px">操作</th></tr></thead>' +
      '<tbody>' + rows + '</tbody></table></div></div>';
  }

  function renderChain(cfg, ups) {
    const sel = cfg.upstreams || [];
    const exc = cfg.exclude || [];
    if (!sel.length && !exc.length) {
      return '<span class="muted">自动（网关自选）</span>';
    }
    const chips = sel.map((u, i) => '<span class="chain-slot"><span class="ord">' + (i + 1) + '</span>' + U.esc(u) + '</span>');
    const exChips = exc.map((u) => '<span class="chain-slot excluded"><span class="ord">✘</span>' + U.esc(u) + '</span>');
    return '<div class="row-gap tight">' + chips.join('<span class="chain-arrow">→</span>') +
      (exChips.length ? '<span class="chain-arrow" style="margin-left:4px">排除</span>' + exChips.join('') : '') + '</div>';
  }

  function renderLegend() {
    return '<div class="card tight"><div class="card-head"><div class="card-title">渠道状态图例</div>' +
      '<div class="card-note">校验后写入本地学习结果，钉住失败的渠道会被自动标记</div></div>' +
      '<div class="row-gap">' + U.statusBadge('ok') + U.statusBadge('limited') + U.statusBadge('bad') + U.statusBadge('auth') + U.statusBadge('unknown') + '</div></div>';
  }

  // 两组请求的对照结果：A 组必须命中目标上游；B 组的无效上游必须被拒绝。
  // 只有两者同时成立才显示「已生效」—— 否则这组参数在这把 key 上就是没起作用。
  function renderVerifyResult(r) {
    if (!r || r.applicable === false) {
      return '<div class="banner" style="margin-top:10px"><span class="b-ico">ℹ</span><div>' +
        U.esc((r && r.message) || '这个模型不需要或没有配置能力过滤，无法做对照验证。') + '</div></div>';
    }
    if (!r.a || !r.b) {
      return '<div class="banner b-critical" style="margin-top:10px"><span class="b-ico">⚠</span><div>' +
        U.esc(r.error || '验证失败') + '</div></div>';
    }
    const row = (k, v) => '<div class="kv"><span class="k">' + U.esc(k) + '</span><span class="v">' + v + '</span></div>';
    return '<div class="badge ' + (r.enforced ? 'b-good' : 'b-serious') + '" style="margin:12px 0">' +
        '<span class="b-ico">' + (r.enforced ? '✔' : '⚠') + '</span>' +
        U.esc(r.enforced ? '能力过滤已生效：only 被真正执行' : '能力过滤未生效：only 可能仍被忽略') + '</div>' +
      '<div class="card tight" style="margin-top:0">' +
        row('A 组 · only=' + r.upstream, 'HTTP ' + U.esc(r.a.status) + ' · 实际 ' +
          (r.a.actual ? '<strong class="mono">' + U.esc(r.a.actual) + '</strong>' : '<span class="muted">未知</span>') +
          ' · ' + (r.a.matched ? '已命中' : '未命中')) +
        row('B 组 · only=not-a-real-provider', (r.b.rejected ? '已被拒绝' : '未被拒绝') + ' · HTTP ' + U.esc(r.b.status)) +
        (r.a.error ? row('A 组错误', '<span class="mono" data-i18n-skip>' + U.esc(r.a.error) + '</span>') : '') +
        (r.b.error ? row('B 组错误', '<span class="mono" data-i18n-skip>' + U.esc(r.b.error) + '</span>') : '') +
        row('结论', U.esc(r.note || '')) +
      '</div>';
  }

  // ---------- 渠道链编辑 ----------
  function openChainEditor(modelId, root) {
    const item = models.find((m) => m.id === modelId);
    const meta = (item && item.meta) || {};
    const cfg = cfgOf(modelId);
    const all = Array.from(new Set([...(meta.upstreams || []), ...(cfg.upstreams || []), ...(cfg.exclude || [])]));
    // 手动输入的候选：从所有模型已学到的渠道里收集，探测不到渠道时也能直接选/填。
    const suggestions = Array.from(new Set([
      ...models.flatMap((m) => (m.meta && m.meta.upstreams) || []),
      ...(cfg.upstreams || []), ...(cfg.exclude || []),
    ])).sort();
    const status = meta.upstreamStatus || {};
    let chain = (cfg.upstreams || []).slice();
    let exclude = (cfg.exclude || []).slice();
    let pinMode = cfg.pinMode || 'strict';
    let sort = cfg.sort || null;
    // 新配置（引擎还没写过 has）且正好是「规划器 + 只钉 deepseek」时，按实测默认预勾选。
    // 用户取消勾选后保存的空数组是显式关闭，下次打开不会被重新勾上。
    const hasConfigured = Array.isArray((perModel[modelId] || {}).has);
    let has = (cfg.has || []).slice();
    if (!hasConfigured && meta.pipeline === 'planner' && chain.length === 1 && chain[0] === 'deepseek') {
      has = suggestedHas(modelId);
    }
    let verifyHTML = '';
    const direct = meta.pipeline === 'direct';
    const extraHas = has.filter((t) => !KNOWN_HAS.includes(t));

    const bodyHTML = () =>
      '<div class="banner"><span class="b-ico">ℹ</span><div>' +
        '管道：' + (meta.pipeline === 'planner' ? '规划器（Vercel AI Gateway）→ 请求体注入 <span class="mono">providerOptions.gateway</span>' :
          meta.pipeline === 'direct' ? '直连（OpenRouter）→ 请求体注入 <span class="mono">provider</span>' : '尚未探测') +
        '<br>按顺序逐个钉住尝试：第一个异常自动顺切下一个，全部失败才把错误透传给客户端。' +
      '</div></div>' +
      '<div class="field"><label class="field-label">钉住链（勾选顺序即尝试顺序，最多 10 个）</label>' +
        '<div id="chainBox" class="row-gap tight" style="min-height:32px">' +
          (chain.length ? chain.map((u, i) =>
            '<span class="chain-slot"><span class="ord">' + (i + 1) + '</span>' + U.esc(u) +
            '<button class="x" data-chain-up="' + i + '" title="上移">↑</button>' +
            '<button class="x" data-chain-down="' + i + '" title="下移">↓</button>' +
            '<button class="x" data-chain-del="' + i + '" title="移除">✕</button></span>').join('<span class="chain-arrow">→</span>')
            : '<span class="muted">为空 = 自动（交给网关自选）</span>') +
        '</div></div>' +
      '<div class="field"><label class="field-label">排除渠道（永不被使用，优先级高于勾选）</label>' +
        '<div class="row-gap tight">' + (exclude.length
          ? exclude.map((u, i) => '<span class="chain-slot excluded"><span class="ord">✘</span>' + U.esc(u) + '<button class="x" data-ex-del="' + i + '">✕</button></span>').join('')
          : '<span class="muted">无</span>') + '</div></div>' +
      '<div class="field"><label class="field-label">可选渠道（点一下加入钉住链，Shift+点加入排除）</label>' +
        '<div class="row-gap tight">' + (all.length
          ? all.map((u) => {
              const st = status[u];
              const inChain = chain.includes(u);
              const isExc = exclude.includes(u);
              return '<button class="btn btn-sm" data-add="' + U.esc(u) + '" title="' + U.esc((st && st.note) || '') + '"' +
                (inChain || isExc ? ' disabled' : '') + '>' + U.esc(u) +
                (st ? ' ' + U.STATUS[st.status].ico : '') + '</button>';
            }).join('')
          : '<span class="muted">还没有渠道清单 —— 用下面的「手动添加渠道」直接填 deepseek 也可以</span>') +
        '</div></div>' +
      '<div class="field"><label class="field-label">手动添加渠道</label>' +
        '<div class="row-gap">' +
          '<input class="input" data-manual-up list="upstreamSuggest" placeholder="如 deepseek（探测不到渠道时用）" style="max-width:280px">' +
          '<button class="btn btn-sm" data-manual-add>加入钉住链</button>' +
          '<button class="btn btn-sm" data-manual-ex>加入排除</button>' +
        '</div>' +
        '<div class="card-note">探测不到渠道（例如请求被服务端虚拟模型配置顶到私有落点）时可以手填上游 slug，比如 <span class="mono">deepseek</span>。这里只负责把它放进候选链；能否真正钉住，仍以「验证钉住是否生效」的结果为准。</div>' +
        '<datalist id="upstreamSuggest">' + suggestions.map((u) => '<option value="' + U.esc(u) + '"></option>').join('') + '</datalist>' +
      '</div>' +
      '<div class="grid-2">' +
        '<div class="field"><label class="field-label">钉住模式</label>' +
          '<select class="select" data-sel="pinMode">' +
            '<option value="strict"' + (pinMode === 'strict' ? ' selected' : '') + '>严格钉住（只用链上渠道）</option>' +
            '<option value="preferred"' + (pinMode === 'preferred' ? ' selected' : '') + '>优先+回退（链优先，可回落网关自选）</option>' +
          '</select></div>' +
        '<div class="field"><label class="field-label">排序偏好</label>' +
          '<select class="select" data-sel="sort">' +
            '<option value=""' + (!sort ? ' selected' : '') + '>网关默认</option>' +
            '<option value="cost"' + (sort === 'cost' ? ' selected' : '') + '>最低成本</option>' +
            '<option value="ttft"' + (sort === 'ttft' ? ' selected' : '') + '>最快首字</option>' +
            '<option value="tps"' + (sort === 'tps' ? ' selected' : '') + '>最高吞吐</option>' +
          '</select></div>' +
      '</div>' +
      '<div class="field"><label class="field-label">能力过滤（providerOptions.gateway.has）</label>' +
        '<div class="row-gap tight">' +
          KNOWN_HAS.map((t) => '<label class="switch"><input type="checkbox" data-has="' + t + '"' +
            (has.includes(t) ? ' checked' : '') + (direct ? ' disabled' : '') + '><span class="track"></span>' +
            '<span class="switch-label mono">' + t + '</span></label>').join('') +
          '<input class="input" data-live="has-custom" value="' + U.esc(extraHas.join(', ')) + '"' +
            ' placeholder="其它能力标签，逗号分隔"' + (direct ? ' disabled' : '') + ' style="max-width:220px">' +
        '</div>' +
        '<div class="card-note">' +
          (direct
            ? '直连管道（OpenRouter）的 provider.only 本来就会透传，不需要能力过滤。'
            : '实测：规划器管道只发 only 会被网关忽略（连不存在的上游也能成功）；带上 has 后 only 才真正生效。钉住 DeepSeek 时建议启用能力过滤：多模态模型（v4.1-flash / vision）用 vision + implicit-caching，纯文本模型只用 implicit-caching —— 标签必须与模型能力匹配，否则可能没有可用上游。') +
        '</div></div>' +
      '<div class="field"><div class="row-gap">' +
        '<button class="btn btn-sm" data-verify ' + (direct || !chain.length || !has.length ? 'disabled' : '') + '>验证钉住是否生效（两组请求）</button>' +
        '<span class="muted">A 组钉住链首；B 组把 only 换成不存在的上游，应当被拒绝。两组都是极小额真实请求。</span>' +
      '</div><div class="verify-result">' + verifyHTML + '</div></div>';

    const m = U.modal({
      title: '配置上游钉住 — ' + modelId,
      width: 680,
      bodyHTML: bodyHTML(),
      confirmLabel: '保存',
      onConfirm: async (wrap) => {
        await API.patchPerModel(modelId, { upstreams: chain, exclude, pinMode, sort: sort || null, has });
        perModel[modelId] = Object.assign({}, cfgOf(modelId), { upstreams: chain, exclude, pinMode, sort: sort || null, has });
        U.toast('已保存 ' + modelId + ' 的钉住配置', 'ok');
        render(root);
      },
    });

    const wrap = m.root;
    const redraw = () => {
      U.$('.modal-body', wrap).innerHTML = bodyHTML();
      wireModal();
    };

    // 手动输入渠道：探测拿不到清单（或清单里没有目标渠道）时的唯一入口。
    // 只做 slug 形状校验；渠道是否真的存在、能否被钉住，交给「/api/test」和两组对照验证。
    function addManual(asExclude) {
      const input = U.$('[data-manual-up]', wrap);
      const v = String((input && input.value) || '').trim().toLowerCase();
      if (!v) return;
      if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(v)) {
        U.toast('渠道名不合法：只能用小写字母、数字、点、下划线、连字符', 'err');
        return;
      }
      if (asExclude) {
        if (!exclude.includes(v)) exclude.push(v);
        chain = chain.filter((u) => u !== v);
      } else {
        if (chain.length >= 10) { U.toast('钉住链最多 10 个', 'err'); return; }
        if (!chain.includes(v)) chain.push(v);
        exclude = exclude.filter((u) => u !== v);
        if (meta.pipeline === 'planner' && chain.length === 1 && chain[0] === 'deepseek' && !has.length) {
          has = suggestedHas(modelId);
        }
      }
      verifyHTML = '';
      redraw();
    }

    function wireModal() {
      U.delegate(wrap, 'click', '[data-add]', (e, el) => {
        const u = el.getAttribute('data-add');
        if (e.shiftKey) { if (!exclude.includes(u)) exclude.push(u); }
        else if (chain.length < 10 && !chain.includes(u)) {
          chain.push(u);
          // 钉住 DeepSeek 时按模型能力预勾选（多模态才带 vision），可手动取消。
          if (meta.pipeline === 'planner' && chain.length === 1 && chain[0] === 'deepseek' && !has.length) {
            has = suggestedHas(modelId);
          }
        }
        redraw();
      });
      U.delegate(wrap, 'click', '[data-chain-del]', (_e, el) => { chain.splice(Number(el.getAttribute('data-chain-del')), 1); redraw(); });
      U.delegate(wrap, 'click', '[data-chain-up]', (_e, el) => {
        const i = Number(el.getAttribute('data-chain-up'));
        if (i > 0) { const t = chain[i - 1]; chain[i - 1] = chain[i]; chain[i] = t; redraw(); }
      });
      U.delegate(wrap, 'click', '[data-chain-down]', (_e, el) => {
        const i = Number(el.getAttribute('data-chain-down'));
        if (i < chain.length - 1) { const t = chain[i + 1]; chain[i + 1] = chain[i]; chain[i] = t; redraw(); }
      });
      U.delegate(wrap, 'click', '[data-ex-del]', (_e, el) => { exclude.splice(Number(el.getAttribute('data-ex-del')), 1); redraw(); });
      U.delegate(wrap, 'change', '[data-sel]', (_e, el) => {
        const k = el.getAttribute('data-sel');
        if (k === 'pinMode') pinMode = el.value;
        if (k === 'sort') sort = el.value || null;
      });
      U.delegate(wrap, 'click', '[data-manual-add]', () => addManual(false));
      U.delegate(wrap, 'click', '[data-manual-ex]', () => addManual(true));
      U.delegate(wrap, 'keydown', '[data-manual-up]', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); addManual(false); }
      });
      U.delegate(wrap, 'change', '[data-has]', (_e, el) => {
        const tag = el.getAttribute('data-has');
        if (el.checked) { if (!has.includes(tag)) has.push(tag); }
        else has = has.filter((t) => t !== tag);
        verifyHTML = '';   // 参数变了，旧结论不再对应当前配置
        redraw();
      });
      // 自定义标签用 input 而不是 change：点「验证」时 input 会先失焦，
      // 若这里重绘 DOM，刚被按下的按钮会连同事件目标一起被换掉，点击就丢了。
      U.delegate(wrap, 'input', '[data-live="has-custom"]', (_e, el) => {
        const extra = el.value.split(/[,，\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean);
        has = [...new Set([...KNOWN_HAS.filter((t) => has.includes(t)), ...extra])];
        verifyHTML = '';
        const box = U.$('.verify-result', wrap);
        if (box) box.innerHTML = '';
        const btn = U.$('[data-verify]', wrap);
        if (btn) btn.disabled = direct || !chain.length || !has.length;
      });
      U.delegate(wrap, 'click', '[data-verify]', async (_e, el) => {
        if (!chain.length || !has.length) return;
        el.disabled = true;
        el.textContent = '验证中…';
        try {
          verifyHTML = renderVerifyResult(await API.verifyPin({ model: modelId, upstream: chain[0], has }));
        } catch (e) {
          verifyHTML = '<div class="banner b-critical" style="margin-top:10px"><span class="b-ico">⚠</span><div>' + U.esc(e.message) + '</div></div>';
        }
        redraw();
      });
    }
    wireModal();
  }

  // ---------- 结果展示 ----------
  function showTestResult(modelId, r) {
    const rows = [];
    rows.push(U.kv('目标链', (r.targets && r.targets.length) ? '<span class="mono">' + r.targets.map(U.esc).join(' → ') + '</span>' : '<span class="muted">自动</span>'));
    if (r.exclude && r.exclude.length) rows.push(U.kv('排除', '<span class="mono">' + r.exclude.map(U.esc).join(', ') + '</span>'));
    if (r.has && r.has.length) rows.push(U.kv('能力过滤', '<span class="mono">' + r.has.map(U.esc).join(', ') + '</span>'));
    rows.push(U.kv('实际渠道', r.actual ? '<strong class="mono">' + U.esc(r.actual) + '</strong>' + (r.actualName && r.actualName !== r.actual ? ' <span class="muted">(' + U.esc(r.actualName) + ')</span>' : '') : '<span class="muted">—</span>'));
    rows.push(U.kv('管道', U.pipelineBadge(r.pipeline)));
    if (r.canonicalSlug) rows.push(U.kv('背后模型', '<span class="mono">' + U.esc(r.canonicalSlug) + '</span>'));
    if (r.fallbacks && r.fallbacks.length) rows.push(U.kv('可用回落', '<span class="mono">' + r.fallbacks.map(U.esc).join(', ') + '</span>'));
    rows.push(U.kv('耗时', U.esc(U.fmtMs(r.ms))));
    if (r.account) rows.push(U.kv('账号', U.esc(r.account)));
    if (r.trace && r.trace.length) rows.push(U.kv('尝试路径', U.attemptPath(r.trace)));

    const adopted = r.ok && r.targets && r.targets.length
      ? (r.targets.includes(r.actual) ? ['good', '✔ 网关采纳了钉住'] : ['serial', '⚠ 网关未采纳，实际走了 ' + (r.actual || '未知')])
      : null;

    const body = (adopted
      ? '<div class="badge ' + (adopted[0] === 'good' ? 'b-good' : 'b-serious') + '" style="margin-bottom:12px"><span class="b-ico">' + (adopted[0] === 'good' ? '✔' : '⚠') + '</span>' + U.esc(adopted[1]) + '</div>'
      : (r.ok ? '' : '<div class="badge b-critical" style="margin-bottom:12px"><span class="b-ico">✘</span>请求失败</div>')) +
      rows.join('') +
      (r.ok
        ? '<div class="field" style="margin-top:12px"><label class="field-label">模型回复</label><div class="mono" style="background:var(--surface-2);border:1px solid var(--hairline);border-radius:7px;padding:8px 10px;user-select:text">' + U.esc(r.content || '(空)') + '</div></div>'
        : '<div class="field" style="margin-top:12px"><label class="field-label">错误</label><div class="mono" style="color:var(--critical);user-select:text">' + U.esc(r.error || '') + '</div></div>');

    U.modal({ title: '测试结果 — ' + modelId, width: 620, bodyHTML: body, confirmLabel: '', cancelLabel: '关闭', onConfirm: null });
  }

  function showValidateResult(modelId, r) {
    const S = r.summary || {};
    const list = Object.entries(r.results || {})
      .sort((a, b) => (a[1].status > b[1].status ? 1 : -1))
      .map(([slug, info]) => '<tr>' +
        '<td class="mono">' + U.esc(slug) + '</td>' +
        '<td>' + U.statusBadge(info.status) + '</td>' +
        '<td>' + U.latCell(info.ms) + '</td>' +
        '<td class="muted" style="font-size:11.5px;user-select:text">' + U.esc((info.note || '').slice(0, 130)) + '</td>' +
      '</tr>').join('');

    const body =
      '<div class="row-gap" style="margin-bottom:12px">' +
        U.statusBadge('ok', '可用 ' + (S.ok || 0)) +
        U.statusBadge('limited', '限流 ' + (S.limited || 0)) +
        U.statusBadge('bad', '不可钉 ' + (S.bad || 0)) +
        U.statusBadge('auth', '密钥问题 ' + (S.auth || 0)) +
        U.statusBadge('unknown', '未知 ' + (S.unknown || 0)) +
      '</div>' +
      ((r.has && r.has.length)
        ? '<div class="banner"><span class="b-ico">ℹ</span><div>本次校验带能力过滤 <span class="mono">' + r.has.map(U.esc).join(', ') + '</span>：不满足这些能力的渠道会被判为「不可钉」，这是过滤条件本身的结果，不是故障。</div></div>'
        : '') +
      '<div class="banner"><span class="b-ico">ℹ</span><div>「不可钉」通常是该渠道被单独钉住时模型 ID 映射失败；「限流」是共享池临时状态，稍后重测或改用「优先+回退」即可。</div></div>' +
      '<div class="table-wrap"><div class="table-scroll"><table class="tbl">' +
      '<thead><tr><th>渠道</th><th style="width:96px">状态</th><th style="width:104px">耗时</th><th>说明</th></tr></thead>' +
      '<tbody>' + list + '</tbody></table></div></div>';

    U.modal({ title: '全渠道校验 — ' + modelId, width: 720, bodyHTML: body, confirmLabel: '', cancelLabel: '关闭', onConfirm: null });
  }

  // ---------- 动作 ----------
  async function doProbe(modelId, root) {
    busy[modelId] = 'probe'; render(root);
    try {
      const r = await API.probe(modelId);
      if (r.ok) {
        U.toast('探测完成：' + (r.pipeline === 'planner' ? '规划器' : r.pipeline === 'direct' ? '直连' : '未知管道') +
          '，' + ((r.upstreams || []).length) + ' 个渠道（' + U.fmtMs(r.ms) + '）', 'ok');
      } else {
        U.toast('探测失败：' + (r.error || '').slice(0, 160), 'err');
      }
    } catch (e) { U.toast('探测失败：' + e.message, 'err'); }
    busy[modelId] = null;
    await fetchAll().catch(() => {});
    render(root);
  }

  async function doTest(modelId, root) {
    const cfg = cfgOf(modelId);
    busy[modelId] = 'test'; render(root);
    try {
      const r = await API.test({ model: modelId, upstreams: cfg.upstreams || [], exclude: cfg.exclude || [], has: cfg.has || [] });
      showTestResult(modelId, r);
      await fetchAll().catch(() => {});
    } catch (e) { U.toast('测试失败：' + e.message, 'err'); }
    busy[modelId] = null;
    render(root);
  }

  async function doValidate(modelId, root) {
    busy[modelId] = 'validate'; render(root);
    try {
      const r = await API.validateUpstreams(modelId);
      showValidateResult(modelId, r);
      await fetchAll().catch(() => {});
    } catch (e) { U.toast('校验失败：' + e.message, 'err'); }
    busy[modelId] = null;
    render(root);
  }

  async function probeAll(root) {
    const targets = models.map((m) => m.id);
    if (!targets.length) return;
    if (!(await U.confirm('探测全部模型', '将对 ' + targets.length + ' 个模型各发一次极小额请求以识别管道与渠道清单。预计耗时 1–3 分钟，继续？', '开始探测'))) return;
    const btnState = {};
    for (const id of targets) btnState[id] = 'probe';
    busy = btnState; render(root);
    let okCount = 0;
    for (const id of targets) {
      try {
        const r = await API.probe(id);
        if (r.ok) okCount++;
      } catch { /* 单个失败不中断 */ }
      delete busy[id];
    }
    busy = {};
    U.toast('探测完成：' + okCount + '/' + targets.length + ' 成功', okCount === targets.length ? 'ok' : 'err');
    await fetchAll().catch(() => {});
    render(root);
  }

  async function validateAll(root) {
    const targets = models.filter((m) => m.meta && (m.meta.upstreams || []).length);
    if (!targets.length) return U.toast('请先探测模型以获取渠道清单', 'err');
    const total = targets.reduce((n, m) => n + (m.meta.upstreams || []).length, 0);
    if (!(await U.confirm('校验全部渠道', '将针对 ' + targets.length + ' 个模型、合计约 ' + total + ' 个渠道各发一次最小请求。渠道多时耗时较久且消耗少量额度，继续？', '开始校验'))) return;
    for (const m of targets) busy[m.id] = 'validate';
    render(root);
    for (const m of targets) {
      try { await API.validateUpstreams(m.id); } catch { /* 继续 */ }
      delete busy[m.id];
      render(root);
    }
    busy = {};
    U.toast('全渠道校验完成', 'ok');
    await fetchAll().catch(() => {});
    render(root);
  }

  async function fetchOfficial(root) {
    const btn = U.$('[data-act="fetch-official"]', root);
    if (btn) { btn.disabled = true; btn.textContent = '拉取中…'; }
    try {
      const r = await API.fetchOfficial();
      const added = r.added || [];
      U.toast('已从 ' + ((r.sources || []).join(' / ') || '未知来源') + ' 找到 ' + (r.found || 0) + ' 个模型' +
        (added.length ? '，新增 ' + added.length + ' 个' : '，无新增'), 'ok');
      if (added.length) {
        U.modal({
          title: '新增订阅模型 ' + added.length + ' 个',
          bodyHTML: '<div class="mono" style="user-select:text;line-height:1.9">' + added.map(U.esc).join('<br>') + '</div>',
          confirmLabel: '', cancelLabel: '知道了',
        });
      }
      await fetchAll().catch(() => {});
    } catch (e) { U.toast('拉取失败：' + e.message, 'err'); }
    if (btn) { btn.disabled = false; btn.textContent = '拉取官方最新模型'; }
    render(root);
  }

  function wire(root) {
    U.delegate(root, 'change', '[data-act="only-probed"]', (_e, el) => { onlyProbed = el.checked; render(root); });
    U.delegate(root, 'click', '[data-act]', (e, el) => {
      const act = el.getAttribute('data-act');
      const row = el.closest('tr');
      const modelId = row && row.getAttribute('data-model');
      if (act === 'probe-all') return probeAll(root);
      if (act === 'validate-all') return validateAll(root);
      if (act === 'fetch-official') return fetchOfficial(root);
      if (!modelId) return;
      if (act === 'chain') return openChainEditor(modelId, root);
      if (act === 'probe') return doProbe(modelId, root);
      if (act === 'test') return doTest(modelId, root);
      if (act === 'validate') return doValidate(modelId, root);
      void e;
    });
  }

  window.VIEWS = window.VIEWS || {};
  window.VIEWS.models = {
    title: '订阅模型',
    sub: () => '识别管道、枚举上游渠道、按序钉住并实测',
    actions: () => '<button class="btn btn-sm" data-act="refresh">重新读取</button>',
    async load(root) {
      root.innerHTML = '<div class="empty">加载中…</div>';
      try { await fetchAll(); } catch (e) { root.innerHTML = U.empty('读取失败：' + e.message); return; }
      render(root); wire(root);
    },
    async onAction(act) {
      if (act === 'refresh') { await window.APP.refresh(); window.APP.renderCurrent(); }
    },
  };
})();
