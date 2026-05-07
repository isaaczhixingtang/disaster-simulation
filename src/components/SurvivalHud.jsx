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
