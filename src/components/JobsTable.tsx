import { format } from "date-fns";
import { CheckCircle2, Clock, XCircle, Loader2, FileText } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

interface VerificationJob {
  id: string;
  telegram_user_id: number;
  telegram_username: string | null;
  total_numbers: number;
  registered_count: number;
  not_registered_count: number;
  status: "pending" | "processing" | "completed" | "failed";
  created_at: string;
  completed_at: string | null;
}

interface JobsTableProps {
  jobs: VerificationJob[];
  onViewResults?: (jobId: string) => void;
}

const statusConfig = {
  pending: {
    label: "Pending",
    icon: Clock,
    className: "bg-warning/10 text-warning border-warning/20",
  },
  processing: {
    label: "Processing",
    icon: Loader2,
    className: "bg-accent/10 text-accent border-accent/20",
  },
  completed: {
    label: "Completed",
    icon: CheckCircle2,
    className: "bg-success/10 text-success border-success/20",
  },
  failed: {
    label: "Failed",
    icon: XCircle,
    className: "bg-destructive/10 text-destructive border-destructive/20",
  },
};

export function JobsTable({ jobs, onViewResults }: JobsTableProps) {
  if (jobs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <div className="rounded-full bg-secondary p-4 mb-4">
          <FileText className="h-8 w-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-medium text-foreground mb-1">
          No verification jobs yet
        </h3>
        <p className="text-sm text-muted-foreground max-w-sm">
          Send a file with phone numbers to your Telegram bot to start
          verifying.
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border overflow-hidden">
      <Table>
        <TableHeader>
          <TableRow className="bg-secondary/30 hover:bg-secondary/30">
            <TableHead className="text-xs uppercase tracking-wider text-muted-foreground">
              User
            </TableHead>
            <TableHead className="text-xs uppercase tracking-wider text-muted-foreground">
              Status
            </TableHead>
            <TableHead className="text-xs uppercase tracking-wider text-muted-foreground text-right">
              Total
            </TableHead>
            <TableHead className="text-xs uppercase tracking-wider text-muted-foreground text-right">
              <span className="text-success">✓</span> Registered
            </TableHead>
            <TableHead className="text-xs uppercase tracking-wider text-muted-foreground text-right">
              <span className="text-destructive">✗</span> Not Registered
            </TableHead>
            <TableHead className="text-xs uppercase tracking-wider text-muted-foreground">
              Created
            </TableHead>
            <TableHead className="text-xs uppercase tracking-wider text-muted-foreground">
              Actions
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {jobs.map((job, index) => {
            const status = statusConfig[job.status];
            const StatusIcon = status.icon;
            
            return (
              <TableRow
                key={job.id}
                className="hover:bg-secondary/20 transition-colors"
                style={{ animationDelay: `${index * 50}ms` }}
              >
                <TableCell className="font-mono text-sm">
                  {job.telegram_username ? (
                    <span className="text-primary">@{job.telegram_username}</span>
                  ) : (
                    <span className="text-muted-foreground">
                      ID: {job.telegram_user_id}
                    </span>
                  )}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn("gap-1.5", status.className)}
                  >
                    <StatusIcon
                      className={cn(
                        "h-3 w-3",
                        job.status === "processing" && "animate-spin"
                      )}
                    />
                    {status.label}
                  </Badge>
                </TableCell>
                <TableCell className="text-right font-mono text-sm">
                  {job.total_numbers.toLocaleString()}
                </TableCell>
                <TableCell className="text-right font-mono text-sm text-success">
                  {job.registered_count.toLocaleString()}
                </TableCell>
                <TableCell className="text-right font-mono text-sm text-destructive">
                  {job.not_registered_count.toLocaleString()}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {format(new Date(job.created_at), "MMM d, HH:mm")}
                </TableCell>
                <TableCell>
                  {job.status === "completed" && onViewResults && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onViewResults(job.id)}
                      className="text-xs hover:text-primary"
                    >
                      View Results
                    </Button>
                  )}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
