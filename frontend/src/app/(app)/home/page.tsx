"use client";
import Link from "next/link";
import { Icon } from "@/components/icons";
import { useAuth } from "@/lib/auth";
const destinations = [
  { href: "/scout", title: "Scouting", description: "Record a robot’s match. Choose your station, start in Auto, then log each made shot.", icon: "clipboard" },
  { href: "/pits", title: "Pits", description: "Find your shift and your team’s next match. Pit rotations and queue times for 418 and 436.", icon: "wrench" },
  { href: "/match-schedule", title: "Match Schedule", description: "Browse the full event schedule. Check alliances and see which match is coming up.", icon: "list" },
];
export default function HomePage() {
  const { session } = useAuth();
  return <div className="home-page">
    <header className="home-heading"><div><h1>Purble Place</h1><p>Your competition day starts here.</p></div><img className="home-lasa" src="/brand/lasa-robotics.png" alt="LASA Robotics" /></header>
    <div className="home-body"><nav className="home-destinations" aria-label="Get started">{destinations.filter(d => !session?.picklist_only || d.href !== "/scout").map((item, i) => <Link key={item.href} href={item.href} className="home-destination"><span className="home-destination-icon"><Icon name={item.icon} /></span><span><h2>{item.title}</h2><p>{item.description}</p></span><svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg></Link>)}</nav><div className="home-mascot"><img src="/brand/urple.png" alt="Purple LASA Robotics mascot" /><span>418 / 436</span></div></div>
    <footer className="home-footer">Need robot details? <Link href="/pit">Open Pit Scouting</Link>.<span>LASA Robotics · Ready for the next match.</span></footer>
  </div>;
}
