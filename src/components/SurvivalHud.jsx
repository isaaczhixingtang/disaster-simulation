const moveButtons = [
  ["up", "ArrowUp", "▲"],
  ["left", "ArrowLeft", "◀"],
  ["down", "ArrowDown", "▼"],
  ["right", "ArrowRight", "▶"],
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
          🪵 Wood: <span id="survival-wood">0</span>
        </div>
        <div className="stat">
          ⏱️ <span id="survival-time">0s</span>
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
