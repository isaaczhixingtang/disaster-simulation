const tourButtons = [
  ["btn-tour-prev", "◀", "Prev", "secondary"],
  ["btn-tour-next", "", "Next ▶", "primary"],
  ["btn-tour-stop", "✕", "End Tour", "danger"],
];

export function ConstructionHud() {
  return (
    <div id="construction-hud" className="hidden">
      <div className="construction-bar">
        <div className="construction-title">
          <span className="icon">🏗️</span>
          <span>Construction Sim</span>
        </div>
        <div id="constr-status" className="construction-status">
          Preparing site...
        </div>
        <div className="construction-actions">
          <button id="btn-constr-add" className="construction-btn add">
            + Add Building
          </button>
          <button id="btn-constr-speed" className="construction-btn speed">
            ⏩ 2× Speed
          </button>
          <button id="btn-constr-tour" className="construction-btn tour" style={{ display: "none" }}>
            🎬 Tour
          </button>
          <button id="constr-exit" className="construction-btn exit">
            🚪 Exit
          </button>
        </div>
      </div>

      <div id="tour-overlay" className="tour-overlay">
        <div id="tour-label" className="tour-label">
          Floor 1
        </div>
        <div className="tour-actions">
          {tourButtons.map(([id, icon, label, variant]) => (
            <button id={id} className={`tour-btn ${variant}`} key={id}>
              {icon && <span className="icon">{icon}</span>}
              <span>{label}</span>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
