import { useQuery } from "@tanstack/react-query";
import { api } from "./api";

/** Owners are stored as member emails; show the member's display name when it is known. */
export function useOwnerName() {
  const members = useQuery({ queryKey: ["team-members"], queryFn: api.teamMembers, staleTime: 60_000 });
  return (owner: string | null | undefined) => {
    if (!owner) return "Unassigned";
    return members.data?.find((member) => member.email === owner)?.displayName ?? owner;
  };
}
