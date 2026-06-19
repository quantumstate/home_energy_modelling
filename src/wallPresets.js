// UK wall construction presets categorised by building era.
// U-values (W/m²K) include standard surface resistances: Rsi=0.13, Rse=0.04.
// Layers are the raw construction materials (no surface resistances) — used to
// seed U-value calculator elements. Lambda is in W/(m·K).
// Air cavities are represented with an effective lambda: λ = t(m) / R_cavity.

export const UK_WALL_PRESETS = [
  {
    id: "pre-1919",
    era: "Pre-1919",
    subtitle: "Solid masonry",
    presets: [
      {
        id: "pre1919-solid-brick",
        name: "Solid brick, uninsulated",
        description: "220mm brick + 13mm dense plaster",
        uValue: 2.09,
        // R: 0.17 + 0.22/0.77 + 0.013/0.57 = 0.479 → U = 2.09
        layers: [
          { name: "Brick", thicknessMm: 220, lambda: 0.77 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
      {
        id: "pre1919-solid-brick-internal-50mw",
        name: "Solid brick + internal lining",
        description: "220mm brick + 50mm mineral wool + 12.5mm plasterboard",
        uValue: 0.54,
        // R: 0.17 + 0.286 + 1.351 + 0.050 = 1.857 → U = 0.54
        layers: [
          { name: "Brick", thicknessMm: 220, lambda: 0.77 },
          { name: "Mineral wool", thicknessMm: 50, lambda: 0.037 },
          { name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
        ],
      },
      {
        id: "pre1919-solid-brick-internal-100pir",
        name: "Solid brick + PIR internal lining",
        description: "220mm brick + 100mm PIR board + 12.5mm plasterboard",
        uValue: 0.20,
        // R: 0.17 + 0.286 + 4.545 + 0.050 = 5.051 → U = 0.20
        layers: [
          { name: "Brick", thicknessMm: 220, lambda: 0.77 },
          { name: "PIR board", thicknessMm: 100, lambda: 0.022 },
          { name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
        ],
      },
      {
        id: "pre1919-solid-stone-sandstone",
        name: "Solid sandstone, uninsulated",
        description: "600mm sandstone (λ=1.3) + 13mm plaster",
        uValue: 1.53,
        // R: 0.17 + 0.600/1.3 + 0.023 = 0.655 → U = 1.53
        layers: [
          { name: "Sandstone", thicknessMm: 600, lambda: 1.3 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
      {
        id: "pre1919-solid-stone-granite",
        name: "Solid granite, uninsulated",
        description: "600mm granite (λ=3.5) + 13mm plaster",
        uValue: 2.86,
        // R: 0.17 + 0.600/3.5 + 0.023 = 0.364 → U = 2.75
        layers: [
          { name: "Granite", thicknessMm: 600, lambda: 3.5 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
    ],
  },
  {
    id: "1919-1944",
    era: "1919–1944",
    subtitle: "Early cavity / solid brick",
    presets: [
      {
        id: "1919-solid-brick",
        name: "Solid brick, uninsulated",
        description: "220mm brick + 13mm dense plaster",
        uValue: 2.09,
        layers: [
          { name: "Brick", thicknessMm: 220, lambda: 0.77 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
      {
        id: "1919-cavity-unfilled",
        name: "Cavity wall, unfilled",
        description: "105mm brick + 50mm cavity + 100mm block + 13mm plaster",
        uValue: 1.42,
        // R: 0.17 + 0.136 + 0.18 + 0.196 + 0.023 = 0.705 → U = 1.42
        // Air cavity λ = 0.050 / 0.18 = 0.278
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "Air cavity", thicknessMm: 50, lambda: 0.278 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
      {
        id: "1919-cavity-injected",
        name: "Cavity wall, injected fill",
        description: "105mm brick + 50mm injected mineral wool + 100mm block + 13mm plaster",
        uValue: 0.57,
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "Injected mineral wool", thicknessMm: 50, lambda: 0.040 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
    ],
  },
  {
    id: "1945-1964",
    era: "1945–1964",
    subtitle: "Standard cavity wall",
    presets: [
      {
        id: "1945-cavity-unfilled",
        name: "Cavity wall, unfilled",
        description: "105mm brick + 50mm cavity + 100mm block + 13mm plaster",
        uValue: 1.42,
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "Air cavity", thicknessMm: 50, lambda: 0.278 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
      {
        id: "1945-no-fines-concrete",
        name: "No-fines concrete, uninsulated",
        description: "225mm no-fines concrete (λ=0.35) + 13mm plaster",
        uValue: 1.20,
        // R: 0.17 + 0.225/0.35 + 0.013/0.57 = 0.836 → U = 1.20
        layers: [
          { name: "No-fines concrete", thicknessMm: 225, lambda: 0.35 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
      {
        id: "1945-cavity-injected",
        name: "Cavity wall, injected fill",
        description: "105mm brick + 50mm injected mineral wool + 100mm block + 13mm plaster",
        uValue: 0.57,
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "Injected mineral wool", thicknessMm: 50, lambda: 0.040 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
    ],
  },
  {
    id: "1965-1979",
    era: "1965–1979",
    subtitle: "First insulation requirements",
    presets: [
      {
        id: "1965-cavity-unfilled",
        name: "Cavity wall, unfilled",
        description: "105mm brick + 50mm cavity + 100mm block + 13mm plaster",
        uValue: 1.42,
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "Air cavity", thicknessMm: 50, lambda: 0.278 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
      {
        id: "1965-cavity-25mm-partial",
        name: "Cavity wall, 25mm partial fill",
        description: "105mm brick + 25mm mineral wool + 25mm residual cavity + 100mm block + 13mm plaster",
        uValue: 0.77,
        // R: 0.17 + 0.136 + 0.676 + 0.09 + 0.196 + 0.023 = 1.291 → U = 0.77
        // 25mm residual cavity λ = 0.025 / 0.09 = 0.278
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "Mineral wool batt", thicknessMm: 25, lambda: 0.037 },
          { name: "Residual air cavity", thicknessMm: 25, lambda: 0.278 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
      {
        id: "1965-cavity-full-fill",
        name: "Cavity wall, 50mm full fill",
        description: "105mm brick + 50mm mineral wool fill + 100mm block + 13mm plaster",
        uValue: 0.48,
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "Mineral wool (full fill)", thicknessMm: 50, lambda: 0.037 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Dense plaster", thicknessMm: 13, lambda: 0.57 },
        ],
      },
    ],
  },
  {
    id: "1980-1995",
    era: "1980–1995",
    subtitle: "Improved Part L standards",
    presets: [
      {
        id: "1980-partial-fill-50mm",
        name: "Cavity wall, 50mm partial fill",
        description: "105mm brick + 50mm mineral wool + 50mm cavity + 100mm block + plasterboard",
        uValue: 0.49,
        // R: 0.17 + 0.136 + 1.351 + 0.18 + 0.196 + 0.050 = 2.083 → U = 0.48
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "Mineral wool batt", thicknessMm: 50, lambda: 0.037 },
          { name: "Residual air cavity", thicknessMm: 50, lambda: 0.278 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
        ],
      },
      {
        id: "1980-full-fill-100mm",
        name: "Cavity wall, 100mm full fill",
        description: "105mm brick + 100mm mineral wool fill + 100mm block + plasterboard",
        uValue: 0.31,
        // R: 0.17 + 0.136 + 2.703 + 0.196 + 0.050 = 3.255 → U = 0.307
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "Mineral wool (full fill)", thicknessMm: 100, lambda: 0.037 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
        ],
      },
    ],
  },
  {
    id: "1996-2006",
    era: "1996–2006",
    subtitle: "Part L 1995/2002",
    presets: [
      {
        id: "1996-full-fill-100mm",
        name: "Cavity wall, 100mm full fill",
        description: "105mm brick + 100mm mineral wool fill + 100mm block + plasterboard",
        uValue: 0.31,
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "Mineral wool (full fill)", thicknessMm: 100, lambda: 0.037 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
        ],
      },
      {
        id: "1996-pir-partial-75mm",
        name: "Cavity wall, 75mm PIR partial fill",
        description: "105mm brick + 75mm PIR board + 25mm cavity + 100mm block + plasterboard",
        uValue: 0.25,
        // R: 0.17 + 0.136 + 3.409 + 0.09 + 0.196 + 0.050 = 4.051 → U = 0.247
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "PIR board", thicknessMm: 75, lambda: 0.022 },
          { name: "Residual air cavity", thicknessMm: 25, lambda: 0.278 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
        ],
      },
    ],
  },
  {
    id: "post-2006",
    era: "Post-2006",
    subtitle: "Modern construction",
    presets: [
      {
        id: "post2006-full-fill-100pir",
        name: "Cavity wall, 100mm PIR full fill",
        description: "105mm brick + 100mm PIR fill + 100mm block + plasterboard",
        uValue: 0.18,
        // R: 0.17 + 0.136 + 4.545 + 0.196 + 0.050 = 5.097 → U = 0.196
        layers: [
          { name: "Outer brick", thicknessMm: 105, lambda: 0.77 },
          { name: "PIR board (full fill)", thicknessMm: 100, lambda: 0.022 },
          { name: "Concrete block", thicknessMm: 100, lambda: 0.51 },
          { name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
        ],
      },
      {
        id: "post2006-timber-frame",
        name: "Timber frame with mineral wool",
        description: "Render + OSB + 140mm mineral wool + vapour barrier + plasterboard",
        uValue: 0.20,
        layers: [
          { name: "Render", thicknessMm: 20, lambda: 0.7 },
          { name: "OSB sheathing", thicknessMm: 11, lambda: 0.13 },
          { name: "Mineral wool (between studs)", thicknessMm: 140, lambda: 0.037 },
          { name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
        ],
      },
      {
        id: "post2006-passivhaus",
        name: "Passivhaus standard",
        description: "200mm continuous mineral wool insulation (λ=0.031)",
        uValue: 0.13,
        // R: 0.17 + 0.200/0.031 ≈ 6.62 → U = 0.151 (framing correction → ~0.13)
        layers: [
          { name: "Outer cladding", thicknessMm: 25, lambda: 0.13 },
          { name: "Mineral wool (continuous)", thicknessMm: 200, lambda: 0.031 },
          { name: "OSB / airtight layer", thicknessMm: 11, lambda: 0.13 },
          { name: "Plasterboard", thicknessMm: 12.5, lambda: 0.25 },
        ],
      },
    ],
  },
];
