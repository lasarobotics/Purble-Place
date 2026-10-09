"use client";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { DeletePicklists } from "@/components/DeletePicklists";
export default function AdminPicklistsPage() {
  const { session } = useAuth();
  if (session?.scout_id !== "Admin" || session?.role !== "admin") return <p>Admin only</p>;
  return <div><div className="page-title"><h1>All Picklists</h1></div><section className="card"><h2>Picklist management</h2><p>Search submitted lists by name or scouter, compare rankings, and manage official results in Meeting Mode.</p><div className="btn-row"><Link className="btn primary" href="/meeting">Picklist Meeting Mode</Link><DeletePicklists /></div></section></div>;
}
