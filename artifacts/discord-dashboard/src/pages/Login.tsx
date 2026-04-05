import { useEffect } from "react";
import { Shield, LogIn, AlertCircle } from "lucide-react";
import { useLocation } from "wouter";

export default function Login() {
  const [location] = useLocation();
  const params = new URLSearchParams(
    typeof window !== "undefined" ? window.location.search : ""
  );
  const error = params.get("error");

  const errorMessages: Record<string, string> = {
    access_denied: "You cancelled the login. Please try again.",
    auth_failed: "Something went wrong during login. Please try again.",
    config_error: "The server is not configured correctly. Contact the admin.",
  };

  function handleLogin() {
    window.location.href = "/api/auth/discord";
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center relative overflow-hidden">
      <div className="absolute inset-0 bg-gradient-to-br from-primary/10 via-transparent to-purple-900/20 pointer-events-none" />
      <div
        className="absolute top-0 left-1/2 -translate-x-1/2 w-[600px] h-[600px] rounded-full pointer-events-none"
        style={{
          background:
            "radial-gradient(circle, rgba(88,101,242,0.15) 0%, transparent 70%)",
        }}
      />

      <div className="relative z-10 w-full max-w-md mx-auto px-6">
        <div
          className="rounded-2xl border border-white/10 p-10 text-center"
          style={{
            background: "rgba(255,255,255,0.03)",
            backdropFilter: "blur(24px)",
            boxShadow: "0 0 60px rgba(88,101,242,0.1), 0 1px 0 rgba(255,255,255,0.05) inset",
          }}
        >
          <div className="flex justify-center mb-6">
            <div
              className="w-16 h-16 rounded-2xl flex items-center justify-center border border-primary/30"
              style={{
                background: "rgba(88,101,242,0.15)",
                boxShadow: "0 0 30px rgba(88,101,242,0.3)",
              }}
            >
              <Shield className="w-9 h-9 text-primary" />
            </div>
          </div>

          <h1 className="text-3xl font-bold text-white mb-1">Bleed</h1>
          <p className="text-muted-foreground text-sm mb-8">
            Connect your Discord account to manage your servers
          </p>

          {error && (
            <div className="flex items-center gap-2 bg-red-500/10 border border-red-500/20 rounded-xl px-4 py-3 mb-6 text-left">
              <AlertCircle className="w-4 h-4 text-red-400 flex-shrink-0" />
              <p className="text-red-400 text-sm">
                {errorMessages[error] ?? "An error occurred. Please try again."}
              </p>
            </div>
          )}

          <button
            onClick={handleLogin}
            className="w-full flex items-center justify-center gap-3 px-6 py-4 rounded-xl font-semibold text-white transition-all duration-200 hover:opacity-90 active:scale-[0.98]"
            style={{
              background: "linear-gradient(135deg, #5865F2 0%, #4752C4 100%)",
              boxShadow: "0 4px 20px rgba(88,101,242,0.4)",
            }}
          >
            <svg
              width="20"
              height="20"
              viewBox="0 0 71 55"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M60.1045 4.8978C55.5792 2.8214 50.7265 1.2916 45.6527 0.41542C45.5603 0.39851 45.468 0.44077 45.4204 0.52529C44.7963 1.6353 44.105 3.0834 43.6209 4.2216C38.1637 3.4046 32.7345 3.4046 27.3892 4.2216C26.905 3.0581 26.1886 1.6353 25.5617 0.52529C25.5141 0.44359 25.4218 0.40133 25.3294 0.41542C20.2584 1.2888 15.4057 2.8186 10.8776 4.8978C10.8384 4.9147 10.8048 4.9429 10.7825 4.9795C1.57795 18.7309 -0.943561 32.1443 0.293408 45.3914C0.299005 45.4562 0.335386 45.5182 0.385761 45.5576C6.45866 50.0174 12.3413 52.7249 18.1147 54.5195C18.2071 54.5477 18.305 54.5139 18.3638 54.4378C19.7295 52.5728 20.9469 50.6063 21.9907 48.5383C22.0523 48.4172 21.9935 48.2735 21.8676 48.2256C19.9366 47.4931 18.0979 46.6 16.3292 45.5858C16.1893 45.5041 16.1781 45.304 16.3068 45.2082C16.679 44.9293 17.0513 44.6391 17.4067 44.3461C17.471 44.2926 17.5606 44.2813 17.6362 44.3151C29.2558 49.6202 41.8354 49.6202 53.3179 44.3151C53.3935 44.2785 53.4831 44.2898 53.5502 44.3433C53.9057 44.6363 54.2779 44.9293 54.6529 45.2082C54.7816 45.304 54.7732 45.5041 54.6333 45.5858C52.8646 46.6197 51.0259 47.4931 49.0921 48.2228C48.9662 48.2707 48.9102 48.4172 48.9718 48.5383C50.038 50.6034 51.2554 52.5699 52.5959 54.435C52.6519 54.5139 52.7526 54.5477 52.845 54.5195C58.6464 52.7249 64.529 50.0174 70.6019 45.5576C70.6551 45.5182 70.6887 45.459 70.6943 45.3942C72.1747 30.0791 68.2147 16.7757 60.1968 4.9823C60.1772 4.9429 60.1437 4.9147 60.1045 4.8978Z"
                fill="white"
              />
            </svg>
            Login with Discord
          </button>

          <p className="text-muted-foreground text-xs mt-6">
            You'll only see servers where you have access and the bot is present.
          </p>
        </div>
      </div>
    </div>
  );
}
