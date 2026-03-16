import { useEffect, useState } from "react";
import { Download, CheckCircle2, XCircle, Copy, Check } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { ScrollArea } from "@/components/ui/scroll-area";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface VerificationResult {
  id: string;
  phone_number: string;
  is_registered: boolean | null;
}

interface ResultsModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  jobId: string | null;
}

export function ResultsModal({ open, onOpenChange, jobId }: ResultsModalProps) {
  const [results, setResults] = useState<VerificationResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState<"registered" | "not_registered" | null>(null);
  const { toast } = useToast();

  useEffect(() => {
    if (open && jobId) {
      fetchResults();
    }
  }, [open, jobId]);

  const fetchResults = async () => {
    if (!jobId) return;
    
    setLoading(true);
    const { data, error } = await supabase
      .from("verification_results")
      .select("*")
      .eq("job_id", jobId);

    if (error) {
      toast({
        title: "Error loading results",
        description: error.message,
        variant: "destructive",
      });
    } else {
      setResults(data || []);
    }
    setLoading(false);
  };

  const registeredNumbers = results.filter((r) => r.is_registered === true);
  const notRegisteredNumbers = results.filter((r) => r.is_registered === false);

  const downloadFile = (numbers: VerificationResult[], filename: string) => {
    const content = numbers.map((n) => n.phone_number).join("\n");
    const blob = new Blob([content], { type: "text/plain" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  };

  const copyToClipboard = async (numbers: VerificationResult[], type: "registered" | "not_registered") => {
    const content = numbers.map((n) => n.phone_number).join("\n");
    await navigator.clipboard.writeText(content);
    setCopied(type);
    setTimeout(() => setCopied(null), 2000);
    toast({
      title: "Copied to clipboard",
      description: `${numbers.length} numbers copied`,
    });
  };

  const NumbersList = ({ numbers, type }: { numbers: VerificationResult[]; type: "registered" | "not_registered" }) => (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <span className="text-sm text-muted-foreground">
          {numbers.length} numbers
        </span>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={() => copyToClipboard(numbers, type)}
            className="gap-2"
          >
            {copied === type ? (
              <Check className="h-4 w-4" />
            ) : (
              <Copy className="h-4 w-4" />
            )}
            Copy
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() =>
              downloadFile(numbers, `${type === "registered" ? "registered" : "not_registered"}_numbers.txt`)
            }
            className="gap-2"
          >
            <Download className="h-4 w-4" />
            Download .txt
          </Button>
        </div>
      </div>
      <ScrollArea className="h-[300px] rounded-lg border border-border bg-secondary/20 p-4">
        <div className="space-y-1 font-mono text-sm">
          {numbers.map((n) => (
            <div key={n.id} className="text-foreground/80">
              {n.phone_number}
            </div>
          ))}
          {numbers.length === 0 && (
            <div className="text-muted-foreground text-center py-8">
              No numbers in this category
            </div>
          )}
        </div>
      </ScrollArea>
    </div>
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            Verification Results
          </DialogTitle>
          <DialogDescription>
            View and download the verification results for this job.
          </DialogDescription>
        </DialogHeader>

        {loading ? (
          <div className="flex items-center justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : (
          <Tabs defaultValue="registered" className="mt-4">
            <TabsList className="grid w-full grid-cols-2">
              <TabsTrigger value="registered" className="gap-2">
                <CheckCircle2 className="h-4 w-4 text-success" />
                Registered ({registeredNumbers.length})
              </TabsTrigger>
              <TabsTrigger value="not_registered" className="gap-2">
                <XCircle className="h-4 w-4 text-destructive" />
                Not Registered ({notRegisteredNumbers.length})
              </TabsTrigger>
            </TabsList>
            <TabsContent value="registered" className="mt-4">
              <NumbersList numbers={registeredNumbers} type="registered" />
            </TabsContent>
            <TabsContent value="not_registered" className="mt-4">
              <NumbersList numbers={notRegisteredNumbers} type="not_registered" />
            </TabsContent>
          </Tabs>
        )}
      </DialogContent>
    </Dialog>
  );
}
