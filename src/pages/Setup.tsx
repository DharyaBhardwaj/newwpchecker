import { useState, useEffect } from "react";
import { Copy, Check, ExternalLink, Terminal, Key, Bot, Webhook, AlertTriangle, Power } from "lucide-react";
import { Header } from "@/components/Header";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";

const WEBHOOK_URL = `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/telegram-bot`;

const Setup = () => {
  const [copied, setCopied] = useState<string | null>(null);
  const [botEnabled, setBotEnabled] = useState(true);
  const [loading, setLoading] = useState(true);
  const { toast } = useToast();

  useEffect(() => {
    fetchBotSettings();
  }, []);

  const fetchBotSettings = async () => {
    const { data } = await supabase
      .from("bot_settings")
      .select("setting_key, setting_value")
      .eq("setting_key", "bot_enabled")
      .single();
    
    if (data) {
      setBotEnabled(data.setting_value === "true");
    }
    setLoading(false);
  };

  const toggleBotEnabled = async () => {
    const newValue = !botEnabled;
    setBotEnabled(newValue);
    
    const { error } = await supabase
      .from("bot_settings")
      .update({ setting_value: newValue ? "true" : "false" })
      .eq("setting_key", "bot_enabled");
    
    if (error) {
      setBotEnabled(!newValue); // Revert on error
      toast({
        title: "Error",
        description: "Failed to update setting",
        variant: "destructive",
      });
    } else {
      toast({
        title: newValue ? "Bot Enabled" : "Bot Disabled",
        description: newValue 
          ? "Other users can now use the bot" 
          : "Only you can use the bot now",
      });
    }
  };

  const copyToClipboard = async (text: string, id: string) => {
    await navigator.clipboard.writeText(text);
    setCopied(id);
    setTimeout(() => setCopied(null), 2000);
    toast({
      title: "Copied to clipboard",
    });
  };

  const CodeBlock = ({ code, id }: { code: string; id: string }) => (
    <div className="relative group">
      <pre className="bg-secondary/50 border border-border rounded-lg p-4 font-mono text-sm overflow-x-auto">
        <code className="text-foreground/90">{code}</code>
      </pre>
      <Button
        variant="ghost"
        size="icon"
        className="absolute top-2 right-2 opacity-0 group-hover:opacity-100 transition-opacity"
        onClick={() => copyToClipboard(code, id)}
      >
        {copied === id ? (
          <Check className="h-4 w-4 text-success" />
        ) : (
          <Copy className="h-4 w-4" />
        )}
      </Button>
    </div>
  );

  return (
    <div className="min-h-screen bg-background">
      <Header />

      <main className="container mx-auto px-4 py-8 max-w-4xl">
        {/* Page Header */}
        <div className="mb-8">
          <h1 className="text-2xl font-bold tracking-tight mb-1">
            <span className="text-primary">$</span> Setup Guide
            <span className="terminal-cursor ml-1 text-primary">_</span>
          </h1>
          <p className="text-sm text-muted-foreground">
            Configure your Telegram bot and WhatsApp verification API
          </p>
        </div>

        {/* Warning Alert */}
        <Alert className="mb-8 border-warning/30 bg-warning/5">
          <AlertTriangle className="h-4 w-4 text-warning" />
          <AlertTitle className="text-warning">Important</AlertTitle>
          <AlertDescription className="text-warning/80">
            The first user who sends a message to the bot will become the owner. 
            Only the owner can toggle access for other users.
          </AlertDescription>
        </Alert>

        {/* Bot Access Control */}
        <Card className="mb-6">
          <CardHeader>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className={`rounded-lg p-2 border ${botEnabled ? 'bg-success/10 border-success/30' : 'bg-destructive/10 border-destructive/30'}`}>
                  <Power className={`h-5 w-5 ${botEnabled ? 'text-success' : 'text-destructive'}`} />
                </div>
                <div>
                  <CardTitle className="text-lg">Bot Access Control</CardTitle>
                  <CardDescription>
                    {botEnabled ? "Other users can use the bot" : "Only you can use the bot"}
                  </CardDescription>
                </div>
              </div>
              <Switch
                checked={botEnabled}
                onCheckedChange={toggleBotEnabled}
                disabled={loading}
              />
            </div>
          </CardHeader>
          <CardContent>
            <p className="text-sm text-muted-foreground">
              When disabled, only the bot owner can send commands. Other users will see an "access denied" message.
              You can also use <code className="bg-secondary px-1.5 py-0.5 rounded">/toggle</code> command in Telegram.
            </p>
          </CardContent>
        </Card>

        <div className="space-y-6">
          {/* Step 1: Create Telegram Bot */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-primary/10 border border-primary/30 p-2">
                  <Bot className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Step 1: Create Telegram Bot</CardTitle>
                  <CardDescription>
                    Get your bot token from @BotFather
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <Accordion type="single" collapsible className="w-full">
                <AccordionItem value="instructions">
                  <AccordionTrigger className="text-sm">
                    View detailed instructions
                  </AccordionTrigger>
                  <AccordionContent className="space-y-3 text-sm text-muted-foreground">
                    <ol className="list-decimal list-inside space-y-2">
                      <li>Open Telegram and search for <code className="bg-secondary px-1.5 py-0.5 rounded">@BotFather</code></li>
                      <li>Send <code className="bg-secondary px-1.5 py-0.5 rounded">/newbot</code> command</li>
                      <li>Choose a name for your bot (e.g., "WhatsApp Checker Bot")</li>
                      <li>Choose a username ending in "bot" (e.g., "wa_checker_bot")</li>
                      <li>Copy the API token provided by BotFather</li>
                    </ol>
                  </AccordionContent>
                </AccordionItem>
              </Accordion>

              <Button variant="outline" className="gap-2" asChild>
                <a href="https://t.me/BotFather" target="_blank" rel="noopener noreferrer">
                  <ExternalLink className="h-4 w-4" />
                  Open BotFather
                </a>
              </Button>
            </CardContent>
          </Card>

          {/* Step 2: Configure Secrets */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-accent/10 border border-accent/30 p-2">
                  <Key className="h-5 w-5 text-accent" />
                </div>
                <div>
                  <CardTitle className="text-lg">Step 2: Configure Secrets</CardTitle>
                  <CardDescription>
                    Add your API keys to Cloud Secrets
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <p className="text-sm text-muted-foreground">
                Add the following secrets in your Cloud console:
              </p>

              <div className="space-y-3">
                <div className="space-y-2">
                  <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                    Required Secrets
                  </Label>
                  <div className="grid gap-2">
                    <div className="flex items-center justify-between bg-secondary/30 rounded-lg px-4 py-3 border border-border">
                      <code className="text-sm font-mono text-primary">TELEGRAM_BOT_TOKEN</code>
                      <span className="text-xs text-muted-foreground">From BotFather</span>
                    </div>
                    <div className="flex items-center justify-between bg-secondary/30 rounded-lg px-4 py-3 border border-border">
                      <code className="text-sm font-mono text-primary">WHATSAPP_API_KEY</code>
                      <span className="text-xs text-muted-foreground">Vonage/Twilio API Key</span>
                    </div>
                    <div className="flex items-center justify-between bg-secondary/30 rounded-lg px-4 py-3 border border-border">
                      <code className="text-sm font-mono text-primary">WHATSAPP_API_SECRET</code>
                      <span className="text-xs text-muted-foreground">Vonage/Twilio API Secret</span>
                    </div>
                  </div>
                </div>
              </div>
            </CardContent>
          </Card>

          {/* Step 3: Set Webhook */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-success/10 border border-success/30 p-2">
                  <Webhook className="h-5 w-5 text-success" />
                </div>
                <div>
                  <CardTitle className="text-lg">Step 3: Set Telegram Webhook</CardTitle>
                  <CardDescription>
                    Connect your bot to this application
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Your Webhook URL
                </Label>
                <div className="flex gap-2">
                  <Input
                    value={WEBHOOK_URL}
                    readOnly
                    className="font-mono text-sm"
                  />
                  <Button
                    variant="outline"
                    size="icon"
                    onClick={() => copyToClipboard(WEBHOOK_URL, "webhook")}
                  >
                    {copied === "webhook" ? (
                      <Check className="h-4 w-4 text-success" />
                    ) : (
                      <Copy className="h-4 w-4" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="space-y-2">
                <Label className="text-xs uppercase tracking-wider text-muted-foreground">
                  Run this command (replace YOUR_BOT_TOKEN)
                </Label>
                <CodeBlock
                  id="curl"
                  code={`curl -X POST "https://api.telegram.org/botYOUR_BOT_TOKEN/setWebhook" \\
  -H "Content-Type: application/json" \\
  -d '{"url": "${WEBHOOK_URL}"}'`}
                />
              </div>
            </CardContent>
          </Card>

          {/* Step 4: Usage */}
          <Card>
            <CardHeader>
              <div className="flex items-center gap-3">
                <div className="rounded-lg bg-primary/10 border border-primary/30 p-2">
                  <Terminal className="h-5 w-5 text-primary" />
                </div>
                <div>
                  <CardTitle className="text-lg">Step 4: Bot Usage</CardTitle>
                  <CardDescription>
                    How to use your WhatsApp checker bot
                  </CardDescription>
                </div>
              </div>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-3 text-sm">
                <div className="flex items-start gap-3">
                  <span className="text-primary font-mono">/start</span>
                  <span className="text-muted-foreground">Welcome message and instructions</span>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-primary font-mono">/check</span>
                  <span className="text-muted-foreground">Check a single number (e.g., /check +1234567890)</span>
                </div>
                <div className="flex items-start gap-3">
                  <span className="text-primary font-mono">.txt file</span>
                  <span className="text-muted-foreground">Upload a text file with one number per line for bulk checking</span>
                </div>
              </div>

              <Alert className="border-muted">
                <Terminal className="h-4 w-4" />
                <AlertTitle>Bulk Format</AlertTitle>
                <AlertDescription className="text-muted-foreground">
                  Your .txt file should contain one phone number per line with country code:
                  <pre className="mt-2 bg-secondary/50 rounded p-2 font-mono text-xs">
{`+1234567890
+9876543210
+1122334455`}
                  </pre>
                </AlertDescription>
              </Alert>
            </CardContent>
          </Card>
        </div>
      </main>
    </div>
  );
};

export default Setup;
