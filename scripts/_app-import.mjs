/**
 * _app-import.mjs —— 让探针拿到「**App 正在用的那一个模块实例**」。
 *
 * ## 为什么不能直接 `import('/src/model/store.ts')`
 *
 * Vite 在 HMR / 依赖重优化之后会给模块 URL 挂一个 `?t=<时间戳>` 做缓存击穿，
 * 而**「带查询串」与「不带查询串」是两个不同的模块实例**。于是现场变成：
 *
 *   · App 用的是 `http://localhost:5199/src/model/store.ts?t=1790476600152`
 *   · 探针 import 的是 `http://localhost:5199/src/model/store.ts`
 *
 * 两者各自 `create()` 出一个 **互相独立的 zustand store**。探针 `setState`
 * 写进的是「影子 store」，页面一无所知：注入的 take 在探针自己读回来时
 * 「明明在」，但页面仍然是空状态 → `roll-verify.mjs` 报
 * **「找不到卷帘 canvas」**。
 *
 * ⛔ 这坑最恶的地方是 **它伪装成产品 bug**（看起来像「卷帘挂了 / 页面没反应」），
 * 而且**只在「dev server 已经跑过一轮 HMR 或依赖重优化」时出现**：冷启动的
 * 服务器上模块 URL 没有 `?t=`，裸路径恰好就是 App 用的那个，于是探针一路绿灯。
 * 也就是说 —— **探针的可信度取决于服务器的新鲜度**，而这件事没人会记得。
 *
 * ## 修法
 *
 * 从 `performance` 里找出 App 实际请求过的那个同 pathname 的 URL，**取最后
 * 一次请求**（那才是当前模块图里活着的那一个），用**完全相同的 URL** 去 import。
 *
 * ⛔ 找不到就**抛**，绝不退回裸路径 —— 退回等于又去写影子 store，把
 * 「静默假红」原样搬回来。宁可探针炸得响亮，也不要它绿得可疑。
 *
 * ## 用法
 *
 * 页面加载后注入一次（两个探针都只导航一次，注入一次就够）：
 *
 *     await evalJs(APP_IMPORT_BOOTSTRAP);
 *     ...
 *     const m = await window.__appImport('/src/model/store.ts');
 */

/** 在页面里定义 `window.__appImport(path)`；返回 `true`。 */
export const APP_IMPORT_BOOTSTRAP = `(() => {
  window.__appImport = async (path) => {
    const hits = performance
      .getEntriesByType('resource')
      .filter((e) => {
        try {
          const u = new URL(e.name);
          return u.origin === location.origin && u.pathname === path;
        } catch {
          return false;
        }
      });
    if (hits.length === 0) {
      throw new Error(
        '找不到 App 请求过的模块 URL：' + path +
        '（页面还没加载它，或路径写错了）—— 拒绝退回裸路径，那会写进影子 store'
      );
    }
    /*
      取最后一次请求：HMR 之后模块图里活着的是带 ?t= 的那个，
      而它一定比裸路径那次「更晚」。resource timing 按 startTime 升序。
    */
    const url = hits[hits.length - 1].name;
    return import(/* @vite-ignore */ url);
  };
  return true;
})()`;

/**
 * 断言「探针 import 到的实例」就是「App 正在渲染的那个 store」。
 *
 * 做法：用 store **自己的 action**（`setKeyCount`）改一个数，看侧栏那行
 * 「N 键 · M 素材」有没有跟着变 —— 侧栏在**所有页面上都在**（不像制作台的
 * take 下拉框只在录制 tab 里），所以这条守卫不挑页面、也不挑 tab。
 *
 * 为什么不用「注入一个 take 看它出现在 DOM 里」：卷帘 tab 下与 take 有关的
 * DOM 只有一句 meta 文案，且选中项是页面私有 `useState`（store 够不着），
 * 注入到数组头部**不保证**改变选中项 —— 那是条会被误判成失败的弱判据。
 *
 * ⛔ 用 action 而不是自己拼一个对象塞进 `project`：前者由 store 负责形状，
 * 探针不必知道 `Key` 长什么样，store 改了 schema 这条守卫也不会假红。
 *
 * @param {string} probeName 报错时用来说清是谁在查
 * @returns 页面里执行的 JS 源串；resolve 为 `{ ok, detail }`
 */
export function storeIdentityCheckSource(probeName) {
  return `(async () => {
    const m = await window.__appImport('/src/model/store.ts');
    const S = m.useStore;
    const before = S.getState().project.keys.length;
    const readDomCount = () => {
      const hit = /(\\d+)\\s*键/.exec(document.body.innerText);
      return hit ? Number(hit[1]) : null;
    };
    const domBefore = readDomCount();
    S.getState().setKeyCount(before + 1);
    await new Promise((r) => setTimeout(r, 600));
    const domAfter = readDomCount();
    S.getState().setKeyCount(before);      // 立刻还原，别影响后面的用例
    await new Promise((r) => setTimeout(r, 300));
    const ok = domBefore === before && domAfter === before + 1;
    return {
      ok,
      detail: ${JSON.stringify(probeName)} +
        '：store 键数 ' + before + ' → ' + (before + 1) +
        '，侧栏读数 ' + domBefore + ' → ' + domAfter +
        (ok ? '' : '（对不上 —— 探针拿到的不是 App 正在用的那个 store 实例，' +
              '所有注入都会写进影子 store）'),
    };
  })()`;
}
