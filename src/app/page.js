import { ConstructionHud } from "../components/ConstructionHud";
import { ModeOverlays } from "../components/ModeOverlays";
import { SimulatorChrome } from "../components/SimulatorChrome";
import { SimulatorEngine } from "../components/SimulatorEngine";
import { SurvivalHud } from "../components/SurvivalHud";

export default function Home() {
  return (
    <>
      <SimulatorEngine />
      <ModeOverlays />
      <ConstructionHud />
      <SurvivalHud />
      <SimulatorChrome />
      <div id="message-box" />
    </>
  );
}
