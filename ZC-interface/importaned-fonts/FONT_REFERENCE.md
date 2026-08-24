# JX_Buff Font Scheme Reference

## Font Files (in fonts/ folder)

These are the game's built-in .ttf font files:

| File | Name | Style |
|------|------|-------|
| fzht_GBK.TTF | 方正黑体 | Default game sans-serif (bold, 28px) |
| fzjz.ttf | 方正剪纸 | Decorative paper-cut style |
| fzxk.ttf | 方正行楷 | Running script calligraphy |
| FangZhengKaiTi-GBK.TTF | 方正楷体 | Regular script / KaiTi |
| MSJH.TTF | 微软简黑 | Microsoft Simplified Black |

The 3 Chinese-named .ttf files are from the MY_FontResource plugin (rounded/cute fonts).

## FontScheme IDs (used by JX_Buff plugin)

From CustomDataDemo.jx3dat, the plugin can override buff name text using these FontScheme IDs:

```
Recommended: 2, 40, 187, 205, 226, 17, 99, 159, 186, 245, 246, 256, 23, 235, 253, 271, 199, 200, 210
```

FontScheme IDs are game engine preset numbers. Each ID maps to a combination of:
- Font face (which .ttf file)
- Font size
- Font color (RGBA)
- Outline/shadow color and thickness
- Bold/italic flags

### Known font usage context (from UI config):

| FontScheme | Usage |
|------------|-------|
| 2 | Panel titles (large, bold) |
| 7 | Buff stack count numbers |
| 15 | Buff duration timers |
| 16 | Custom mode button text |
| 18 | Edit fields, buttons, search boxes |
| 40 | Buff name (one recommended ID) |
| 187 | Buff name text (another recommended ID) |
| 228 | Tooltips, notifications (small) |
| 237 | Small button labels |

## For web game usage

Use `@font-face` in CSS to load the .ttf files, then apply different font sizes, colors, outlines, and weights to replicate FontScheme variations.
