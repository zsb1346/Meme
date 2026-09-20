/** @type {import('tailwindcss').Config} */

/**
 * 主题映射 —— 方案 · Apple Neutral。
 *
 * 色值唯一来源 = src/styles/tokens.css（空格分隔 RGB 三元组），
 * 此处仅按变量引用，`<alpha-value>` 占位保证所有透明度修饰符
 * （如 bg-flame-400/15）继续可用。
 *
 * ⚠️ **透明度修饰符必须在 opacity 刻度内（0/5/10/15/…/100），否则类名被静默丢弃。**
 * Tailwind 不会报错、不会警告，只是那条规则根本不生成 —— 样式无声消失，
 * 排查时看源码完全正常。已实测中招的：`bg-flame-600/28`、`bg-danger/12`
 * （键位失效警告的红底）、`bg-flame-600/18`（混音台信号流带的「已启用」底色）。
 * 需要刻度外的值就写方括号形式：`bg-danger/[0.12]`。
 * 自检办法：`npx tailwindcss -i src/index.css -o out.css` 后 grep 类名。
 *
 * 关键设计：`slate` 族被【整体重映射】为 Apple 中性灰阶。
 * 现有组件层有 250+ 处 `text-slate-400` / `bg-slate-600` 之类的类名，
 * 重映射后一处不改即全部落到 Apple 色系 —— 这是「零波及组件层」的实现手段。
 * 后续精修组件时再逐步换成语义 token（text-hi / text-lo / text-faint）。
 *
 * `flame` 族前缀是历史包袱，语义已是「强调色」（现为 Apple systemBlue）。
 * 沿用旧名同样是为了零波及：全站 130+ 处 flame-* 引用不需要改动。
 */
export default {
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        /* —— 面阶梯（四级 + 凹槽 + 强边框）—— */
        ink: {
          950: 'rgb(var(--ink-950) / <alpha-value>)',
          900: 'rgb(var(--ink-900) / <alpha-value>)',
          800: 'rgb(var(--ink-800) / <alpha-value>)',
          700: 'rgb(var(--ink-700) / <alpha-value>)',
          600: 'rgb(var(--ink-600) / <alpha-value>)',
        },
        /* —— 强调色阶梯（Apple systemBlue；唯一交互色）—— */
        flame: {
          200: 'rgb(var(--flame-200) / <alpha-value>)',
          300: 'rgb(var(--flame-300) / <alpha-value>)',
          400: 'rgb(var(--flame-400) / <alpha-value>)',
          500: 'rgb(var(--flame-500) / <alpha-value>)',
          600: 'rgb(var(--flame-600) / <alpha-value>)',
          700: 'rgb(var(--flame-700) / <alpha-value>)',
        },
        /* —— 辅色（仅频谱 / 混响可视化，非第二强调色）—— */
        violet: {
          400: 'rgb(var(--violet-400) / <alpha-value>)',
          500: 'rgb(var(--violet-500) / <alpha-value>)',
        },
        /* —— 功能色（状态语义）—— */
        success: 'rgb(var(--success) / <alpha-value>)',
        warning: 'rgb(var(--warning) / <alpha-value>)',
        danger: 'rgb(var(--danger) / <alpha-value>)',

        /**
         * `slate` 整体重映射为 Apple 中性灰阶（零色偏）。
         *
         * 相对 v1 已整体抬高：v1 的 700~950 压到 3A/2C/1C，导致
         * 「面阶梯看不出差别、整屏发闷」。现在与 tokens.css 的 ink 阶梯
         * 保持一致（950=页面底 / 900=面板 / 800=浮起面 / 700=hover / 600=强边框）。
         * 语义与 Tailwind 默认 slate 一致（数字越大越暗），故现有用法的
         * 对比关系自动成立，无需逐处校对。
         */
        slate: {
          50: '#F2F2F7',
          100: '#F2F2F7',
          200: '#E5E5EA',
          300: '#D1D1D6',
          400: '#C7C7CC',
          500: '#AEAEB2',
          600: '#8E8E93',
          700: '#48484A',
          800: '#2C2C2E',
          900: '#1C1C1E',
          950: '#0E0E10',
        },

        /**
         * 文本语义色阶 —— 走 Apple 的 label 术语（label / secondaryLabel /
         * tertiaryLabel / quaternaryLabel）。
         *
         * 命名坑（务必别改回去）：**颜色键绝对不能以 `text-` 开头**。
         * Tailwind 的 `text-<x>` 同时服务「文字颜色」与「字号」两个命名空间，
         * 若颜色键叫 `text-muted`，那么 `text-text-muted` 会被解析成
         * 「字号 = text-muted」→ 判定为未定义类：
         *   · 在 `@apply` 里直接抛错、整份 CSS 构建失败；
         *   · 在 JSX 里**静默失效**（类名不生成，样式无声消失，最难查）。
         * 用 `label-*` 前缀则得到 `text-label-muted`，零歧义。
         */
        label: {
          DEFAULT: 'rgb(var(--text-hi) / <alpha-value>)',
          hi: 'rgb(var(--text-hi) / <alpha-value>)',
          lo: 'rgb(var(--text-lo) / <alpha-value>)',
          muted: 'rgb(var(--text-muted) / <alpha-value>)',
          faint: 'rgb(var(--text-faint) / <alpha-value>)',
        },

        /* —— 发丝线（全站只有两级）—— */
        line: {
          DEFAULT: 'rgb(var(--line))',
          hot: 'rgb(var(--line-hot))',
        },

        /* —— 语义别名（ui/ 组件套件消费；与上同源）—— */
        bg: 'rgb(var(--bg) / <alpha-value>)',
        surface: {
          DEFAULT: 'rgb(var(--surface) / <alpha-value>)',
          raised: 'rgb(var(--surface-raised) / <alpha-value>)',
        },
        border: 'rgb(var(--border) / <alpha-value>)',
        accent: {
          DEFAULT: 'rgb(var(--accent) / <alpha-value>)',
          strong: 'rgb(var(--accent-strong) / <alpha-value>)',
        },
      },

      /**
       * 圆角三档（全部收小到「工具」量级）：
       *   rounded-sm  → 4px  控件 / 图标按钮
       *   rounded-md  → 6px  面板 / 卡片
       *   rounded-lg/xl/2xl/3xl → 10px 大容器 / 弹窗
       *
       * v1 用的是 6/9/13 —— 13px 铺到一切地方（连 icon 按钮与开关滑块
       * 都吃到），观感偏「糖果」。苹果的规矩是「控件小圆角、容器大圆角」。
       *
       * 现有组件的 rounded-lg / rounded-xl / rounded-2xl 会全部收到 10px，
       * 无需逐处改动 —— 这是「圆角收敛」的实现手段。
       */
      borderRadius: {
        DEFAULT: '4px',
        sm: '4px',
        md: '6px',
        lg: '10px',
        xl: '10px',
        '2xl': '10px',
        '3xl': '10px',
      },

      /* —— 字号六档（body 压到 12.5px）—— */
      fontSize: {
        micro: ['9px', { lineHeight: '1.35' }],
        tiny: ['10px', { lineHeight: '1.4' }],
        small: ['11px', { lineHeight: '1.45' }],
        body: ['12.5px', { lineHeight: '1.5' }],
        lead: ['14px', { lineHeight: '1.45' }],
        title: ['17px', { lineHeight: '1.3' }],
      },

      /* —— 控件高度三档 —— */
      height: {
        'ctl-sm': '26px',
        'ctl-md': '30px',
        'ctl-lg': '36px',
      },
      minHeight: {
        'ctl-sm': '26px',
        'ctl-md': '30px',
        'ctl-lg': '36px',
      },

      /* —— 动效曲线 —— */
      transitionTimingFunction: {
        out: 'cubic-bezier(0.22, 1, 0.36, 1)',
        pop: 'cubic-bezier(0.34, 1.56, 0.64, 1)',
      },

      fontFamily: {
        sans: [
          '-apple-system',
          'BlinkMacSystemFont',
          '"SF Pro Text"',
          '"PingFang SC"',
          '"Microsoft YaHei"',
          'system-ui',
          'sans-serif',
        ],
        mono: [
          '"SF Mono"',
          'ui-monospace',
          '"JetBrains Mono"',
          '"Cascadia Code"',
          'Consolas',
          'monospace',
        ],
      },
    },
  },
  plugins: [],
};
