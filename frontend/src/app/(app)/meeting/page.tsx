"use client";
import {useEffect} from "react";
import {useRouter} from "next/navigation";
export default function RetiredMeeting(){const router=useRouter();useEffect(()=>router.replace("/picklists"),[router]);return <p>Opening picklists?</p>;}
