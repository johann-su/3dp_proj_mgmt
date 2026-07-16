"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Trash2 } from "lucide-react";
import { USER_ROLES } from "@/lib/roles";
import { Badge } from "@/components/ui/badge";
import { Button, buttonVariants } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { deleteUser, setUserRole } from "./actions";

export type UserRow = {
  id: string;
  name: string;
  email: string;
  role: string;
  signedUp: string;
  modelCount: number;
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

  async function removeUser(userId: string) {
    setBusyId(userId);
    const result = await deleteUser({ userId });
    if (result?.error) toast.error(result.error);
    else toast.success("User deleted.");
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
              // Admins can't change their own role or delete their own
              // account (see actions.ts), so don't render controls that can
              // only fail.
              <div
                className="text-sm text-muted-foreground"
                title="You can't change your own role"
              >
                {roleLabels[u.role] ?? u.role}
              </div>
            ) : (
              <>
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
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="text-destructive hover:text-destructive"
                      disabled={busyId === u.id}
                      title="Delete user"
                    >
                      <Trash2 className="size-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        Delete {u.name}&rsquo;s account?
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {u.modelCount > 0 && (
                          <>
                            <strong>
                              This user has uploaded{" "}
                              {u.modelCount === 1
                                ? "1 model"
                                : `${u.modelCount} models`}
                              ,
                            </strong>{" "}
                            which will be permanently deleted along with all
                            files and version history — there is no trash
                            period.{" "}
                          </>
                        )}
                        The account, its collections, and any connected Bambu
                        or Onshape credentials are removed permanently. This
                        cannot be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        className={buttonVariants({ variant: "destructive" })}
                        onClick={() => removeUser(u.id)}
                      >
                        Delete user
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </>
            )}
          </div>
        );
      })}
    </div>
  );
}
