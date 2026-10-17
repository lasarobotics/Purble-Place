import { DataAnalysisPanel } from "@/components/DataAnalysisPanel";

export default function DataAnalysisPage() {
  return <div><div className="page-title"><h1>Data Analysis</h1></div><p className="faint">HazeHub scouting analysis with live Match 13 event ratings. Select any heading to sort; hover a metric name for its meaning and formula.</p><section className="card"><DataAnalysisPanel /></section></div>;
}
