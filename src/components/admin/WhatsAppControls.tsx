import { useState, useEffect } from "react";
import { Smartphone, Wifi, WifiOff, QrCode, RefreshCw, Power, Key, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";

interface WhatsAppSession {
  id: string;
  session_id: string;
  is_connected: boolean;
  phone_number: string | null;
  updated_at: string;
}

export function WhatsAppControls() {
  const [session, setSession] = useState<WhatsAppSession | null>(null);
  const [qrCode, setQrCode] = useState<string | null>(null);
  const [pairingPhone, setPairingPhone] = useState("");
  const [pairingCode, setPairingCode] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const { toast } = useToast();

  // Fetch initial session from database
  const fetchSession = async () => {
    try {
      const { data, error } = await supabase
        .from("whatsapp_sessions")
        .select("*")
        .eq("session_id", "main")
        .maybeSingle();

      if (error) throw error;
      setSession(data);
    } catch (e) {
      console.error("Session fetch error:", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchSession();

    // Subscribe to realtime updates
    const channel = supabase
      .channel("whatsapp-status")
      .on(
        "postgres_changes",
        {
          event: "*",
          schema: "public",
          table: "whatsapp_sessions",
          filter: "session_id=eq.main",
        },
        (payload) => {
          console.log("[Realtime] WhatsApp session update:", payload);
          if (payload.eventType === "DELETE") {
            setSession(null);
          } else {
            setSession(payload.new as WhatsAppSession);
          }
          
          // Clear QR/pairing code if connected
          if ((payload.new as WhatsAppSession)?.is_connected) {
            setQrCode(null);
            setPairingCode(null);
            toast({
              title: "✅ WhatsApp Connected!",
              description: `Linked to +${(payload.new as WhatsAppSession).phone_number || "Unknown"}`,
            });
          }
        }
      )
      .subscribe();

    return () => {
      supabase.removeChannel(channel);
    };
  }, [toast]);

  const handleConnect = async () => {
    setActionLoading("connect");
    setQrCode(null);
    setPairingCode(null);

    try {
      // Start connection
      await supabase.functions.invoke("whatsapp-checker", {
        body: { action: "connect" },
      });

      // Wait for QR
      await new Promise((r) => setTimeout(r, 3000));

      // Get QR
      const { data, error } = await supabase.functions.invoke("whatsapp-checker", {
        body: { action: "get_qr" },
      });

      if (error) throw error;

      if (data.qr) {
        setQrCode(data.qr);
        toast({ title: "QR Code Ready", description: "Scan with WhatsApp" });
      } else if (data.status === "already_connected") {
        toast({ title: "Already Connected", description: "WhatsApp is already linked" });
        fetchSession();
      } else {
        toast({
          title: "QR Not Available",
          description: "Try again in a few seconds",
          variant: "destructive",
        });
      }
    } catch (e) {
      toast({
        title: "Connection Error",
        description: "Failed to start connection",
        variant: "destructive",
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handlePair = async () => {
    if (!pairingPhone) {
      toast({
        title: "Phone Required",
        description: "Enter phone number with country code",
        variant: "destructive",
      });
      return;
    }

    setActionLoading("pair");
    setPairingCode(null);
    setQrCode(null);

    try {
      const { data, error } = await supabase.functions.invoke("whatsapp-checker", {
        body: { action: "pair", phone_number: pairingPhone },
      });

      if (error) throw error;

      if (data.code) {
        setPairingCode(data.code);
        toast({
          title: "Pairing Code Ready",
          description: "Enter this code in WhatsApp",
        });
      } else {
        toast({
          title: "Pairing Failed",
          description: data.message || "Try again",
          variant: "destructive",
        });
      }
    } catch (e) {
      toast({
        title: "Pairing Error",
        description: "Failed to get pairing code",
        variant: "destructive",
      });
    } finally {
      setActionLoading(null);
    }
  };

  const handleReconnect = async () => {
    setActionLoading("reconnect");
    setQrCode(null);
    setPairingCode(null);

    try {
      const { error } = await supabase.functions.invoke("whatsapp-checker", {
        body: { action: "reconnect" },
      });

      if (error) throw error;

      toast({
        title: "Reconnecting",
        description: "Session cleared. Get new QR code to connect.",
      });
      
      // Wait and fetch new QR
      setTimeout(handleConnect, 2000);
    } catch (e) {
      toast({
        title: "Reconnect Error",
        description: "Failed to reconnect",
        variant: "destructive",
      });
      setActionLoading(null);
    }
  };

  const handleDisconnect = async () => {
    setActionLoading("disconnect");

    try {
      const { error } = await supabase.functions.invoke("whatsapp-checker", {
        body: { action: "disconnect" },
      });

      if (error) throw error;

      toast({ title: "Disconnected", description: "WhatsApp session cleared" });
      setQrCode(null);
      setPairingCode(null);
    } catch (e) {
      toast({
        title: "Disconnect Error",
        description: "Failed to disconnect",
        variant: "destructive",
      });
    } finally {
      setActionLoading(null);
    }
  };

  const formatLastUpdate = (dateStr: string) => {
    const date = new Date(dateStr);
    const now = new Date();
    const diffMs = now.getTime() - date.getTime();
    const diffSec = Math.floor(diffMs / 1000);
    
    if (diffSec < 60) return `${diffSec}s ago`;
    if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
    if (diffSec < 86400) return `${Math.floor(diffSec / 3600)}h ago`;
    return date.toLocaleDateString();
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h3 className="text-lg font-semibold flex items-center gap-2">
          <Smartphone className="h-5 w-5" />
          WhatsApp Connection
        </h3>
        <Card>
          <CardContent className="p-6">
            <div className="animate-pulse flex items-center gap-3">
              <div className="h-6 w-6 bg-muted rounded-full" />
              <div className="space-y-2">
                <div className="h-4 w-32 bg-muted rounded" />
                <div className="h-3 w-24 bg-muted rounded" />
              </div>
            </div>
          </CardContent>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <h3 className="text-lg font-semibold flex items-center gap-2">
        <Smartphone className="h-5 w-5" />
        WhatsApp Connection
        <Badge variant="outline" className="ml-2 text-xs font-normal">
          <span className="relative flex h-2 w-2 mr-1">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-primary opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-primary"></span>
          </span>
          Live
        </Badge>
      </h3>

      {/* Status Card */}
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              {session?.is_connected ? (
                <Wifi className="h-6 w-6 text-primary" />
              ) : (
                <WifiOff className="h-6 w-6 text-destructive" />
              )}
              <div>
                <CardTitle className="text-lg">
                  {session?.is_connected ? "Connected" : "Not Connected"}
                </CardTitle>
                <CardDescription className="flex items-center gap-2">
                  {session?.phone_number ? `+${session.phone_number}` : "No phone linked"}
                  {session?.updated_at && (
                    <span className="flex items-center gap-1 text-xs text-muted-foreground">
                      <Clock className="h-3 w-3" />
                      {formatLastUpdate(session.updated_at)}
                    </span>
                  )}
                </CardDescription>
              </div>
            </div>
            <Badge 
              variant={session?.is_connected ? "default" : "secondary"}
            >
              {session?.is_connected ? "Online" : "Offline"}
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-2">
            {!session?.is_connected && (
              <Button
                onClick={handleConnect}
                disabled={actionLoading !== null}
                className="gap-2"
              >
                <QrCode className="h-4 w-4" />
                {actionLoading === "connect" ? "Getting QR..." : "Get QR Code"}
              </Button>
            )}
            <Button
              variant="outline"
              onClick={handleReconnect}
              disabled={actionLoading !== null}
              className="gap-2"
            >
              <RefreshCw className={`h-4 w-4 ${actionLoading === "reconnect" ? "animate-spin" : ""}`} />
              Reconnect
            </Button>
            {session?.is_connected && (
              <Button
                variant="destructive"
                onClick={handleDisconnect}
                disabled={actionLoading !== null}
                className="gap-2"
              >
                <Power className="h-4 w-4" />
                {actionLoading === "disconnect" ? "Disconnecting..." : "Disconnect"}
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {/* QR Code Display */}
      {qrCode && (
        <Card>
          <CardHeader>
            <CardTitle className="text-lg flex items-center gap-2">
              <QrCode className="h-5 w-5" />
              Scan QR Code
            </CardTitle>
            <CardDescription>
              Open WhatsApp → Linked Devices → Link a Device
            </CardDescription>
          </CardHeader>
          <CardContent className="flex justify-center">
            <img
              src={qrCode}
              alt="WhatsApp QR Code"
              className="max-w-[280px] rounded-lg border"
            />
          </CardContent>
        </Card>
      )}

      {/* Pairing Code Method */}
      <Card>
        <CardHeader>
          <CardTitle className="text-lg flex items-center gap-2">
            <Key className="h-5 w-5" />
            Pairing Code (Alternative)
          </CardTitle>
          <CardDescription>
            Link with 8-digit code instead of QR
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-2">
            <Input
              placeholder="+91XXXXXXXXXX"
              value={pairingPhone}
              onChange={(e) => setPairingPhone(e.target.value)}
              className="max-w-xs"
            />
            <Button
              onClick={handlePair}
              disabled={actionLoading !== null}
              variant="outline"
            >
              {actionLoading === "pair" ? "Getting Code..." : "Get Code"}
            </Button>
          </div>

          {pairingCode && (
            <div className="bg-secondary/50 rounded-lg p-4 text-center">
              <Label className="text-xs text-muted-foreground">Enter this code in WhatsApp</Label>
              <p className="text-3xl font-mono font-bold tracking-widest mt-2 text-primary">
                {pairingCode}
              </p>
            </div>
          )}
        </CardContent>
      </Card>

      {!session && (
        <p className="text-sm text-muted-foreground">
          ⚠️ No WhatsApp session found. Deploy the Baileys server and connect first.
        </p>
      )}
    </div>
  );
}
