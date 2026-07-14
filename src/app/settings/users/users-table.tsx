"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { USER_ROLES } from "@/lib/roles";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { setUserRole } from "./actions";

export type UserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  signedUp: string;
};

const roleLabels: Record<string, string> = {
  user: "User",
  moderator: "Moderator",
  admin: "Admin",
};

export function UsersTable({
  users,
  currentUserId,
}: {
  users: UserRow[];
  currentUserId: string;
}) {
  const router = useRouter();
  const [busyId, setBusyId] = useState<string | null>(null);

  async function changeRole(userId: string, role: string) {
    setBusyId(userId);
    const result = await setUserRole({ userId, role });
    if (result?.error) toast.error(result.error);
    else toast.success("Role updated.");
    setBusyId(null);
    router.refresh();
  }

  return (
    <div className="grid gap-3">
      {users.map((u) => {
        const isSelf = u.id === currentUserId;
        return (
          <div
            key={u.id}
            className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border p-3"
          >
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate font-medium">{u.name}</span>
                {isSelf && <Badge variant="outline">You</Badge>}
              </div>
              <div className="truncate text-sm text-muted-foreground">
                {u.email} · joined {u.signedUp}
              </div>
            </div>
            {isSelf ? (
              // Admins can't change their own role (see setUserRole), so
              // don't render a control that can only fail.
              <div
                className="text-sm text-muted-foreground"
                title="You can't change your own role"
              >
                {roleLabels[u.role] ?? u.role}
              </div>
            ) : (
              <Select
                value={u.role}
                disabled={busyId === u.id}
                onValueChange={(role) => changeRole(u.id, role)}
              >
                <SelectTrigger className="w-32" size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {USER_ROLES.map((role) => (
                    <SelectItem key={role} value={role}>
                      {roleLabels[role]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            )}
          </div>
        );
      })}
    </div>
  );
}
