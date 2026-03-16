import { useEffect, useState } from "react";
import { Activity, CheckCircle2, XCircle, Users, RefreshCw } from "lucide-react";
import { Header } from "@/components/Header";
import { StatsCard } from "@/components/StatsCard";
import { JobsTable } from "@/components/JobsTable";
import { ResultsModal } from "@/components/ResultsModal";
import { Button } from "@/components/ui/button";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

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

interface Stats {
  totalJobs: number;
  totalNumbers: number;
  registeredNumbers: number;
  notRegisteredNumbers: number;
}

const Index = () => {
  const [jobs, setJobs] = useState<VerificationJob[]>([]);
  const [stats, setStats] = useState<Stats>({
    totalJobs: 0,
    totalNumbers: 0,
    registeredNumbers: 0,
    notRegisteredNumbers: 0,
  });
  const [loading, setLoading] = useState(true);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [resultsModalOpen, setResultsModalOpen] = useState(false);
  const { toast } = useToast();

  const fetchData = async () => {
    setLoading(true);
    
    const { data: jobsData, error: jobsError } = await supabase
      .from("verification_jobs")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50);

    if (jobsError) {
      toast({
        title: "Error loading data",
        description: jobsError.message,
        variant: "destructive",
      });
    } else {
      const typedJobs = (jobsData || []) as VerificationJob[];
      setJobs(typedJobs);
      
      // Calculate stats
      const totalJobs = typedJobs.length;
      const totalNumbers = typedJobs.reduce((sum, job) => sum + job.total_numbers, 0);
      const registeredNumbers = typedJobs.reduce((sum, job) => sum + job.registered_count, 0);
      const notRegisteredNumbers = typedJobs.reduce((sum, job) => sum + job.not_registered_count, 0);
      
      setStats({
        totalJobs,
        totalNumbers,
        registeredNumbers,
        notRegisteredNumbers,
      });
    }
    
    setLoading(false);
  };

  useEffect(() => {
    fetchData();

    // Subscribe to realtime updates
    const channel = supabase
      .channel("verification_jobs_changes")
      .on(
        "postgres_changes",
        { event: "*", schema: "public", table: "verification_jobs" },
        () => {
          fetchData();
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, []);

  const handleViewResults = (jobId: string) => {
    setSelectedJobId(jobId);
    setResultsModalOpen(true);
  };

  return (
    <div className="min-h-screen bg-background">
      <Header />
      
      <main className="container mx-auto px-4 py-8">
        {/* Page Header */}
        <div className="flex items-center justify-between mb-8">
          <div>
            <h1 className="text-2xl font-bold tracking-tight mb-1">
              <span className="text-primary">$</span> Dashboard
              <span className="terminal-cursor ml-1 text-primary">_</span>
            </h1>
            <p className="text-sm text-muted-foreground">
              Monitor your WhatsApp number verification jobs
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            onClick={fetchData}
            disabled={loading}
            className="gap-2"
          >
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>

        {/* Stats Grid */}
        <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4 mb-8">
          <StatsCard
            title="Total Jobs"
            value={stats.totalJobs}
            icon={Users}
            description="Verification batches processed"
          />
          <StatsCard
            title="Numbers Checked"
            value={stats.totalNumbers.toLocaleString()}
            icon={Activity}
            description="Total phone numbers verified"
          />
          <StatsCard
            title="Registered"
            value={stats.registeredNumbers.toLocaleString()}
            icon={CheckCircle2}
            description="Numbers on WhatsApp"
            variant="success"
          />
          <StatsCard
            title="Not Registered"
            value={stats.notRegisteredNumbers.toLocaleString()}
            icon={XCircle}
            description="Numbers not on WhatsApp"
            variant="warning"
          />
        </div>

        {/* Jobs Table */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="text-lg font-semibold">Recent Jobs</h2>
            <span className="text-xs text-muted-foreground font-mono">
              [ {jobs.length} records ]
            </span>
          </div>
          <JobsTable jobs={jobs} onViewResults={handleViewResults} />
        </div>

        {/* Results Modal */}
        <ResultsModal
          open={resultsModalOpen}
          onOpenChange={setResultsModalOpen}
          jobId={selectedJobId}
        />
      </main>
    </div>
  );
};

export default Index;
