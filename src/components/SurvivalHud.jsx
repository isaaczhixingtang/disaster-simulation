const moveButtons = [
  ["up", "KeyW", "▲"],
  ["left", "KeyA", "◀"],
  ["down", "KeyS", "▼"],
  ["right", "KeyD", "▶"],
  ["punch", "Digit1", "👊"],
  ["action", "KeyE", "🪓"],
];

export function SurvivalHud() {
  return (
    <>
      <div id="survival-hud" className="hidden">
        <div className="stat">
          ❤️ HP: <span id="survival-hp">100</span>
          <div className="health-bar">
            <div className="health-bar-fill" id="survival-hpbar" style={{ width: "100%" }} />
          </div>
        </div>
        <div className="stat">
          Inventory: 🪵 <span id="survival-wood">0</span> 🍎 <span id="survival-apples">0</span>
        </div>
        <div className="stat">
          ⏱️ <span id="survival-time">0s</span>
        </div>
        <div className="survival-hotbar" id="survival-hotbar" aria-label="Inventory hotbar">
          {Array.from({ length: 9 }, (_, index) => (
            <button
              type="button"
              className={`inventory-slot${index === 0 ? " selected" : ""}`}
              data-slot={index}
              aria-label={`Inventory slot ${index + 1}`}
              key={index}
            >
              <span className="slot-item" />
              <span className="slot-count" />
            </button>
          ))}
        </div>
        <button className="exit-btn" id="survival-exit">
          Exit
        </button>
        <button className="settings-btn" id="survival-settings-btn" type="button" aria-expanded="false">
          ⚙ Settings
        </button>
        <section id="survival-settings-panel" className="survival-settings-panel hidden" aria-label="Survival settings">
          <h2>Movement for Survival</h2>
          <div className="setting-row">
            <span>Movement</span>
            <div className="setting-toggle" role="group" aria-label="Movement keys">
              <button
                type="button"
                className="selected"
                data-survival-movement="wasd"
                id="survival-movement-wasd"
              >
                W A S D
              </button>
              <button type="button" data-survival-movement="arrows" id="survival-movement-arrows">
                Arrow Keys
              </button>
            </div>
          </div>
          <div className="setting-row">
            <span>Looking Around</span>
            <strong id="survival-look-setting">Arrow Keys</strong>
          </div>
          <h2>World Settings</h2>
          {[
            ["deer", "Deer speed", 67],
            ["bear", "Bear speed", 30],
            ["wolf", "Wolf speed", 80],
            ["cow", "Cow speed", 16],
            ["rabbit", "Rabbit speed", 86],
          ].map(([species, label, value]) => (
            <label className="setting-row setting-range" key={species}>
              <span>
                {label}: <strong id={`survival-animal-speed-${species}-value`}>{value}/100</strong>
              </span>
              <input
                type="range"
                min="0"
                max="100"
                defaultValue={value}
                data-survival-animal-speed={species}
                aria-label={label}
              />
            </label>
          ))}
          <label className="setting-row setting-range">
            <span>
              Apple rarity: <strong id="survival-apple-rarity-value">21%</strong>
            </span>
            <input
              type="range"
              min="0"
              max="100"
              defaultValue="21"
              data-survival-setting="appleRarity"
              aria-label="Apple rarity"
            />
          </label>
          <label className="setting-row setting-range">
            <span>
              Sapling growth: <strong id="survival-sapling-growth-value">120 sec.</strong>
            </span>
            <input
              type="range"
              min="5"
              max="300"
              step="5"
              defaultValue="120"
              data-survival-setting="saplingGrowSeconds"
              aria-label="Sapling growth speed"
            />
          </label>
        </section>
      </div>

      <div id="survival-controls">
        {moveButtons.map(([className, key, label]) => (
          <div className={`move-btn ${className}`} data-key={key} key={key}>
            {label}
          </div>
        ))}
      </div>
      <div id="survival-prompt" />
      <div id="survival-crosshair" />
      <div id="survival-message" />
    </>
  );
}
