import { useState, useEffect } from "react";
import { Users, Ban, CheckCircle, Trash2, Search, Shield } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
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
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface User {
  telegram_user_id: number;
  telegram_username: string | null;
  plan: string;
  numbers_limit: number;
  is_active: boolean;
  is_blocked: boolean;
  last_active: string | null;
  created_at: string;
  total_jobs: number;
  total_numbers: number;
}

export function UsersManagement() {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState("");
  const { toast } = useToast();

  const fetchUsers = async () => {
    setLoading(true);
    
    // Get all subscriptions with their job stats
    const { data: subscriptions, error } = await supabase
      .from("subscriptions")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) {
      toast({
        title: "Error loading users",
        description: error.message,
        variant: "destructive",
      });
      setLoading(false);
      return;
    }

    // Get job stats for each user
    const { data: jobStats } = await supabase
      .from("verification_jobs")
      .select("telegram_user_id, total_numbers");

    const statsMap = new Map<number, { total_jobs: number; total_numbers: number }>();
    (jobStats || []).forEach((job) => {
      const existing = statsMap.get(job.telegram_user_id) || { total_jobs: 0, total_numbers: 0 };
      statsMap.set(job.telegram_user_id, {
        total_jobs: existing.total_jobs + 1,
        total_numbers: existing.total_numbers + job.total_numbers,
      });
    });

    const usersWithStats: User[] = (subscriptions || []).map((sub) => ({
      telegram_user_id: sub.telegram_user_id,
      telegram_username: sub.telegram_username,
      plan: sub.plan,
      numbers_limit: sub.numbers_limit,
      is_active: sub.is_active,
      is_blocked: (sub as { is_blocked?: boolean }).is_blocked || false,
      last_active: (sub as { last_active?: string }).last_active || null,
      created_at: sub.created_at,
      total_jobs: statsMap.get(sub.telegram_user_id)?.total_jobs || 0,
      total_numbers: statsMap.get(sub.telegram_user_id)?.total_numbers || 0,
    }));

    setUsers(usersWithStats);
    setLoading(false);
  };

  useEffect(() => {
    fetchUsers();
  }, []);

  const toggleBlock = async (userId: number, currentlyBlocked: boolean) => {
    const { error } = await supabase
      .from("subscriptions")
      .update({ is_blocked: !currentlyBlocked })
      .eq("telegram_user_id", userId);

    if (error) {
      toast({
        title: "Error",
        description: "Failed to update user status",
        variant: "destructive",
      });
    } else {
      toast({
        title: currentlyBlocked ? "User Unblocked" : "User Blocked",
        description: `User ${userId} has been ${currentlyBlocked ? "unblocked" : "blocked"}`,
      });
      fetchUsers();
    }
  };

  const makeAdmin = async (userId: number) => {
    const { error } = await supabase
      .from("user_roles")
      .upsert({ user_id: userId, role: "admin" }, { onConflict: "user_id,role" });

    if (error) {
      toast({
        title: "Error",
        description: "Failed to make user admin",
        variant: "destructive",
      });
    } else {
      toast({
        title: "Admin Added",
        description: `User ${userId} is now an admin`,
      });
    }
  };

  const filteredUsers = users.filter(
    (user) =>
      user.telegram_user_id.toString().includes(searchQuery) ||
      (user.telegram_username?.toLowerCase().includes(searchQuery.toLowerCase()))
  );

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Users className="h-5 w-5" />
          User Management
        </h3>
        <div className="relative w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input
            placeholder="Search users..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="pl-9"
          />
        </div>
      </div>

      <div className="border rounded-lg">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>User</TableHead>
              <TableHead>Plan</TableHead>
              <TableHead>Jobs</TableHead>
              <TableHead>Numbers</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Joined</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {loading ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  Loading users...
                </TableCell>
              </TableRow>
            ) : filteredUsers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={7} className="text-center py-8 text-muted-foreground">
                  No users found
                </TableCell>
              </TableRow>
            ) : (
              filteredUsers.map((user) => (
                <TableRow key={user.telegram_user_id}>
                  <TableCell>
                    <div>
                      <p className="font-medium">{user.telegram_username || "No username"}</p>
                      <p className="text-xs text-muted-foreground">ID: {user.telegram_user_id}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <Badge variant={user.plan === "free" ? "secondary" : "default"}>
                      {user.plan}
                    </Badge>
                  </TableCell>
                  <TableCell>{user.total_jobs}</TableCell>
                  <TableCell>{user.total_numbers.toLocaleString()}</TableCell>
                  <TableCell>
                    {user.is_blocked ? (
                      <Badge variant="destructive">Blocked</Badge>
                    ) : user.is_active ? (
                      <Badge variant="outline" className="border-success text-success">Active</Badge>
                    ) : (
                      <Badge variant="secondary">Inactive</Badge>
                    )}
                  </TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {new Date(user.created_at).toLocaleDateString()}
                  </TableCell>
                  <TableCell className="text-right">
                    <div className="flex items-center justify-end gap-2">
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => toggleBlock(user.telegram_user_id, user.is_blocked)}
                        title={user.is_blocked ? "Unblock" : "Block"}
                      >
                        {user.is_blocked ? (
                          <CheckCircle className="h-4 w-4 text-success" />
                        ) : (
                          <Ban className="h-4 w-4 text-destructive" />
                        )}
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={() => makeAdmin(user.telegram_user_id)}
                        title="Make Admin"
                      >
                        <Shield className="h-4 w-4 text-primary" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <p className="text-xs text-muted-foreground">
        Total: {users.length} users | Blocked: {users.filter((u) => u.is_blocked).length}
      </p>
    </div>
  );
}
