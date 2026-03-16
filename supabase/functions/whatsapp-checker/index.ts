import "jsr:@supabase/functions-js/edge-runtime.d.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const BAILEYS_SERVER_URL = Deno.env.get("BAILEYS_SERVER_URL");

// Check if Baileys server is connected
async function isBaileysConnected(): Promise<boolean> {
  if (!BAILEYS_SERVER_URL) return false;
  
  try {
    const response = await fetch(`${BAILEYS_SERVER_URL}/status`, {
      method: "GET",
      headers: { "Content-Type": "application/json" },
    });
    
    if (!response.ok) return false;
    
    const data = await response.json();
    return data.connected === true;
  } catch (e) {
    console.log("[WA Check] Baileys server not reachable:", e);
    return false;
  }
}

// Check using Baileys (100% accurate)
async function checkViaBaileys(phoneNumber: string): Promise<{ registered: boolean; method: string; confidence: number }> {
  try {
    const response = await fetch(`${BAILEYS_SERVER_URL}/check`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ phone_number: phoneNumber }),
    });
    
    if (!response.ok) {
      throw new Error(`Baileys check failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    if (data.error) {
      throw new Error(data.error);
    }
    
    return {
      registered: data.is_registered === true,
      method: "baileys",
      confidence: 100,
    };
  } catch (e) {
    console.log("[WA Check] Baileys check error:", e);
    throw e;
  }
}

// Batch check using Baileys (sequential for accuracy)
async function batchCheckViaBaileys(phoneNumbers: string[]): Promise<{ phone_number: string; is_registered: boolean; method: string; confidence: number }[]> {
  try {
    const response = await fetch(`${BAILEYS_SERVER_URL}/check-batch`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ 
        phone_numbers: phoneNumbers
        // No concurrency param - server handles it sequentially
      }),
    });
    
    if (!response.ok) {
      throw new Error(`Baileys batch check failed: ${response.status}`);
    }
    
    const data = await response.json();
    
    return data.results.map((r: { phone_number: string; is_registered: boolean }) => ({
      phone_number: r.phone_number,
      is_registered: r.is_registered === true,
      method: "baileys",
      confidence: 100,
    }));
  } catch (e) {
    console.log("[WA Check] Baileys batch check error:", e);
    throw e;
  }
}

// Fallback: Web-based check (less accurate)
async function checkViaWeb(phoneNumber: string): Promise<{ registered: boolean; method: string; confidence: number }> {
  const cleanNumber = phoneNumber.replace(/[^0-9]/g, "");
  
  console.log(`[WA Check] Web fallback for: ${cleanNumber}`);
  
  // Check if number format is valid
  const isValidFormat = /^[1-9]\d{6,14}$/.test(cleanNumber);
  
  if (!isValidFormat) {
    return { registered: false, method: "format-check", confidence: 95 };
  }
  
  // Fallback heuristic based on country codes with high WhatsApp adoption
  const highWhatsAppCountries = ["91", "55", "52", "62", "92", "234", "20", "880", "84", "63", "79"];
  const isLikelyRegistered = highWhatsAppCountries.some(c => cleanNumber.startsWith(c));
  
  return { 
    registered: isLikelyRegistered, 
    method: "heuristic-fallback", 
    confidence: 30  // Very low confidence without Baileys
  };
}

// Main handler
Deno.serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { action, phone_numbers, phone_number } = await req.json();
    
    console.log(`[WhatsApp Checker] Action: ${action}`);
    
    // Check if Baileys is available
    const baileysConnected = await isBaileysConnected();
    console.log(`[WhatsApp Checker] Baileys connected: ${baileysConnected}`);

    if (action === "check_single") {
      if (!phone_number) {
        return new Response(
          JSON.stringify({ error: "phone_number is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      let result;
      
      if (baileysConnected) {
        try {
          result = await checkViaBaileys(phone_number);
        } catch (e) {
          console.log("[WA Check] Baileys failed, using fallback");
          result = await checkViaWeb(phone_number);
        }
      } else {
        result = await checkViaWeb(phone_number);
      }
      
      return new Response(
        JSON.stringify({ 
          phone_number, 
          is_registered: result.registered,
          method: result.method,
          confidence: result.confidence,
          baileys_connected: baileysConnected
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    if (action === "check_batch") {
      if (!phone_numbers || !Array.isArray(phone_numbers)) {
        return new Response(
          JSON.stringify({ error: "phone_numbers array is required" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      if (phone_numbers.length > 100) {
        return new Response(
          JSON.stringify({ error: "Maximum 100 numbers per batch" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      let results;
      
      if (baileysConnected) {
        try {
          results = await batchCheckViaBaileys(phone_numbers);
        } catch (e) {
          console.log("[WA Check] Baileys batch failed, using fallback");
          results = await Promise.all(
            phone_numbers.map(async (num) => {
              const r = await checkViaWeb(num);
              return { phone_number: num, is_registered: r.registered, method: r.method, confidence: r.confidence };
            })
          );
        }
      } else {
        results = await Promise.all(
          phone_numbers.map(async (num) => {
            const r = await checkViaWeb(num);
            return { phone_number: num, is_registered: r.registered, method: r.method, confidence: r.confidence };
          })
        );
      }
      
      const registered = results.filter((r) => r.is_registered);
      const notRegistered = results.filter((r) => !r.is_registered);
      
      return new Response(
        JSON.stringify({
          total: phone_numbers.length,
          registered_count: registered.length,
          not_registered_count: notRegistered.length,
          results,
          baileys_connected: baileysConnected
        }),
        { headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }
    
    // Get Baileys connection status
    if (action === "status") {
      if (!BAILEYS_SERVER_URL) {
        return new Response(
          JSON.stringify({ 
            configured: false,
            message: "BAILEYS_SERVER_URL not configured"
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      try {
        const response = await fetch(`${BAILEYS_SERVER_URL}/status`);
        const data = await response.json();
        
        return new Response(
          JSON.stringify({ 
            configured: true,
            ...data
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ 
            configured: true,
            connected: false,
            error: "Server not reachable"
          }),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
    
    // Get QR code for connection
    if (action === "get_qr") {
      if (!BAILEYS_SERVER_URL) {
        return new Response(
          JSON.stringify({ error: "BAILEYS_SERVER_URL not configured" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      try {
        const response = await fetch(`${BAILEYS_SERVER_URL}/qr`);
        const data = await response.json();
        
        return new Response(
          JSON.stringify(data),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Failed to get QR code" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
    
    // Start connection (generates new QR)
    if (action === "connect") {
      if (!BAILEYS_SERVER_URL) {
        return new Response(
          JSON.stringify({ error: "BAILEYS_SERVER_URL not configured" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      try {
        const response = await fetch(`${BAILEYS_SERVER_URL}/connect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const data = await response.json();
        
        return new Response(
          JSON.stringify(data),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Failed to start connection" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
    
    // Disconnect WhatsApp
    if (action === "disconnect") {
      if (!BAILEYS_SERVER_URL) {
        return new Response(
          JSON.stringify({ error: "BAILEYS_SERVER_URL not configured" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      try {
        const response = await fetch(`${BAILEYS_SERVER_URL}/disconnect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const data = await response.json();
        
        return new Response(
          JSON.stringify(data),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Failed to disconnect" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
    
    // Force reconnect
    if (action === "reconnect") {
      if (!BAILEYS_SERVER_URL) {
        return new Response(
          JSON.stringify({ error: "BAILEYS_SERVER_URL not configured" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      try {
        const response = await fetch(`${BAILEYS_SERVER_URL}/reconnect`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
        });
        const data = await response.json();
        
        return new Response(
          JSON.stringify(data),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Failed to reconnect" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }
    
    // Get pairing code
    if (action === "pair") {
      if (!BAILEYS_SERVER_URL) {
        return new Response(
          JSON.stringify({ error: "BAILEYS_SERVER_URL not configured" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      if (!phone_number) {
        return new Response(
          JSON.stringify({ error: "phone_number required for pairing" }),
          { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
      
      try {
        const response = await fetch(`${BAILEYS_SERVER_URL}/pair`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phone_number }),
        });
        const data = await response.json();
        
        return new Response(
          JSON.stringify(data),
          { headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      } catch (e) {
        return new Response(
          JSON.stringify({ error: "Failed to get pairing code" }),
          { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
        );
      }
    }

    return new Response(
      JSON.stringify({ error: "Invalid action. Use 'check_single', 'check_batch', 'status', 'get_qr', 'connect', 'disconnect', 'reconnect', or 'pair'" }),
      { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
    
  } catch (error) {
    console.error("Error processing request:", error);
    return new Response(
      JSON.stringify({ error: "Internal server error" }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
