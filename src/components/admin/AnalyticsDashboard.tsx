import { useState, useEffect } from "react";
import { BarChart3, TrendingUp, Calendar, Activity } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
  Legend,
} from "recharts";

interface DailyData {
  date: string;
  checks: number;
  registered: number;
  notRegistered: number;
}

interface Stats {
  totalChecks: number;
  totalJobs: number;
  uniqueUsers: number;
  avgPerJob: number;
  registeredPercent: number;
}

export function AnalyticsDashboard() {
  const [dailyData, setDailyData] = useState<DailyData[]>([]);
  const [stats, setStats] = useState<Stats | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetchAnalytics();
  }, []);

  const fetchAnalytics = async () => {
    setLoading(true);

    // Get all jobs
    const { data: jobs } = await supabase
      .from("verification_jobs")
      .select("*")
      .order("created_at", { ascending: false });

    if (!jobs) {
      setLoading(false);
      return;
    }

    // Calculate overall stats
    const totalJobs = jobs.length;
    const totalChecks = jobs.reduce((sum, j) => sum + j.total_numbers, 0);
    const totalRegistered = jobs.reduce((sum, j) => sum + j.registered_count, 0);
    const uniqueUsers = new Set(jobs.map((j) => j.telegram_user_id)).size;
    const avgPerJob = totalJobs > 0 ? Math.round(totalChecks / totalJobs) : 0;
    const registeredPercent = totalChecks > 0 ? Math.round((totalRegistered / totalChecks) * 100) : 0;

    setStats({
      totalChecks,
      totalJobs,
      uniqueUsers,
      avgPerJob,
      registeredPercent,
    });

    // Group by day (last 7 days)
    const dailyMap = new Map<string, { checks: number; registered: number; notRegistered: number }>();
    const today = new Date();
    
    for (let i = 6; i >= 0; i--) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      const dateStr = date.toISOString().split("T")[0];
      dailyMap.set(dateStr, { checks: 0, registered: 0, notRegistered: 0 });
    }

    jobs.forEach((job) => {
      const dateStr = job.created_at.split("T")[0];
      if (dailyMap.has(dateStr)) {
        const existing = dailyMap.get(dateStr)!;
        dailyMap.set(dateStr, {
          checks: existing.checks + job.total_numbers,
          registered: existing.registered + job.registered_count,
          notRegistered: existing.notRegistered + job.not_registered_count,
        });
      }
    });

    const dailyArray: DailyData[] = [];
    dailyMap.forEach((value, key) => {
      const date = new Date(key);
      dailyArray.push({
        date: date.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" }),
        ...value,
      });
    });

    setDailyData(dailyArray);
    setLoading(false);
  };

  const pieData = stats
    ? [
        { name: "Registered", value: stats.registeredPercent, color: "hsl(var(--success))" },
        { name: "Not Registered", value: 100 - stats.registeredPercent, color: "hsl(var(--warning))" },
      ]
    : [];

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-muted-foreground">Loading analytics...</div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold flex items-center gap-2">
        <BarChart3 className="h-5 w-5" />
        Analytics & Statistics
      </h3>

      {/* Quick Stats */}
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Checks</CardDescription>
            <CardTitle className="text-2xl">{stats?.totalChecks.toLocaleString() || 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Total Jobs</CardDescription>
            <CardTitle className="text-2xl">{stats?.totalJobs || 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Unique Users</CardDescription>
            <CardTitle className="text-2xl">{stats?.uniqueUsers || 0}</CardTitle>
          </CardHeader>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardDescription>Avg per Job</CardDescription>
            <CardTitle className="text-2xl">{stats?.avgPerJob || 0}</CardTitle>
          </CardHeader>
        </Card>
      </div>

      <div className="grid gap-6 lg:grid-cols-2">
        {/* Daily Checks Chart */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <TrendingUp className="h-5 w-5" />
              Last 7 Days
            </CardTitle>
            <CardDescription>Numbers checked per day</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyData}>
                  <CartesianGrid strokeDasharray="3 3" className="stroke-border" />
                  <XAxis dataKey="date" className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} />
                  <YAxis className="text-xs" tick={{ fill: "hsl(var(--muted-foreground))" }} />
                  <Tooltip
                    contentStyle={{
                      backgroundColor: "hsl(var(--card))",
                      border: "1px solid hsl(var(--border))",
                      borderRadius: "8px",
                    }}
                  />
                  <Bar dataKey="registered" name="Registered" fill="hsl(var(--success))" radius={[4, 4, 0, 0]} />
                  <Bar dataKey="notRegistered" name="Not Registered" fill="hsl(var(--warning))" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>

        {/* Registration Ratio */}
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <Activity className="h-5 w-5" />
              Registration Ratio
            </CardTitle>
            <CardDescription>Overall percentage of registered numbers</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="h-[300px]">
              <ResponsiveContainer width="100%" height="100%">
                <PieChart>
                  <Pie
                    data={pieData}
                    cx="50%"
                    cy="50%"
                    innerRadius={60}
                    outerRadius={100}
                    paddingAngle={5}
                    dataKey="value"
                    label={({ name, value }) => `${name}: ${value}%`}
                  >
                    {pieData.map((entry, index) => (
                      <Cell key={`cell-${index}`} fill={entry.color} />
                    ))}
                  </Pie>
                  <Legend />
                  <Tooltip />
                </PieChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
