import type { Metadata } from "next";
import { VoteView } from "@/components/views/VoteView";

export const metadata: Metadata = { title: "Vote" };

export default function VotePage() {
  return <VoteView />;
}
