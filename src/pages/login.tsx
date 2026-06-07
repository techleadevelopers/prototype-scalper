import { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useLocation } from "wouter";
import { useConnectBingX } from "@/api-client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { useToast } from "@/hooks/use-toast";
import { AlertCircle, KeyRound, Lock } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

const formSchema = z.object({
  apiKey: z.string().min(1, "API Key is required"),
  secretKey: z.string().min(1, "Secret Key is required"),
});

export default function LoginPage() {
  const [, setLocation] = useLocation();
  const { toast } = useToast();

  const connectMutation = useConnectBingX();

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      apiKey: "",
      secretKey: "",
    },
  });

  function onSubmit(values: z.infer<typeof formSchema>) {
    connectMutation.mutate(
      { data: values },
      {
        onSuccess: (data) => {
          if (data.connected) {
            toast({
              title: "Connected successfully",
              description: "Redirecting to dashboard...",
            });
            setLocation("/dashboard");
          } else {
            toast({
              title: "Connection failed",
              description: "Invalid API keys",
              variant: "destructive",
            });
          }
        },
        onError: (error) => {
          toast({
            title: "Connection Error",
            description: error.data?.error || "Failed to connect to BingX",
            variant: "destructive",
          });
        },
      }
    );
  }

  return (
    <>
      <div className="min-h-screen bg-background flex flex-col items-center justify-center p-4">
        <div className="w-full max-w-md space-y-8">
          <div className="flex flex-col items-center text-center space-y-2">
            {/* Logo com efeito animado - 15% maior */}
            <div className="relative group mb-4">
              <div className="absolute inset-0 bg-gradient-to-r from-primary/50 top-10 to-blue-500/50 rounded-full blur-xl opacity-75 group-hover:opacity-100 transition-opacity duration-500 animate-pulse"></div>
              <img 
                src="https://res.cloudinary.com/limpeja/image/upload/v1780811123/bull-removebg-preview_r86ebz.png" 
                alt="Logo" 
                className="w-[185px] h-[185px] object-contain relative z-10 top-10 animate-float"
              />
            </div>
            <h1 className="kanit-title text-3xl md:text-4xl font-bold tracking-tight bg-gradient-to-r from-white via-blue-200 to-white bg-clip-text text-transparent">
              Futures Finance
            </h1>
            <p className="text-muted-foreground text-sm md:text-base font-light tracking-wide">
              Professional futures trading dashboard
            </p>
          </div>

          <Card className="border-muted bg-card shadow-xl">
            <CardHeader>
              <CardTitle>Connect Account</CardTitle>
              <CardDescription>
                Enter your BingX API credentials to access the terminal.
              </CardDescription>
            </CardHeader>
            
            <CardContent>
              <Form {...form}>
                <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-6">
                  <FormField
                    control={form.control}
                    name="apiKey"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>API Key</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <KeyRound className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                            <Input className="pl-9 font-mono" placeholder="Enter API Key" {...field} />
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  
                  <FormField
                    control={form.control}
                    name="secretKey"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Secret Key</FormLabel>
                        <FormControl>
                          <div className="relative">
                            <Lock className="absolute left-3 top-3 h-4 w-4 text-muted-foreground" />
                            <Input className="pl-9 font-mono" type="password" placeholder="Enter Secret Key" {...field} />
                          </div>
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <Button 
                    type="submit" 
                    className="relative w-full group bg-transparent text-white font-bold py-3 px-4 rounded-full transition-all duration-300 transform hover:scale-[1.02] active:scale-[0.98] overflow-hidden border-0 outline-none shadow-none"
                    disabled={connectMutation.isPending}
                    style={{ border: 'none', boxShadow: 'none', borderRadius: '100px' }}
                  >
                    {/* Fundo interno */}
                    <div className="absolute inset-0 rounded-full bg-gradient-to-r from-blue-900/40 via-white/[0.12] to-blue-900/40"></div>
                    
                    {/* Efeito de luz que caminha no meio (scan horizontal) */}
                    <div className="absolute inset-0 rounded-full overflow-hidden">
                      <div className="absolute top-0 left-0 w-full h-full" style={{
                        background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.5), rgba(59,130,246,0.8), rgba(59,130,246,0.5), transparent)',
                        transform: 'translateX(-100%)',
                        animation: 'scanLight 2.5s ease-in-out infinite',
                        width: '40%',
                        height: '100%',
                        filter: 'blur(4px)'
                      }}></div>
                    </div>
                    
                    {/* Segundo efeito de luz mais sutil no hover */}
                    <div className="absolute inset-0 rounded-full overflow-hidden opacity-0 group-hover:opacity-100 transition-opacity duration-500">
                      <div className="absolute top-0 left-0 w-full h-full" style={{
                        background: 'linear-gradient(90deg, transparent, rgba(59,130,246,0.6), rgba(96,165,250,0.9), rgba(59,130,246,0.6), transparent)',
                        transform: 'translateX(-100%)',
                        animation: 'scanLightFast 1.5s ease-in-out infinite',
                        width: '30%',
                        height: '100%',
                        filter: 'blur(2px)'
                      }}></div>
                    </div>
                    
                    {/* Hover effect - fundo mais claro */}
                    <div className="absolute inset-0 rounded-full bg-blue-500/0 group-hover:bg-blue-500/10 transition-all duration-300"></div>
                    
                    <span className="relative z-10 flex items-center justify-center gap-2 font-medium tracking-wide" style={{ fontFamily: 'GT-Flexa, sans-serif', color: 'white', fontSize: '105%', letterSpacing: '0.1em' }}>
                      {connectMutation.isPending ? (
                        <>
                          <div className="w-4 h-4 border-2 border-blue-400/30 border-t-blue-400 rounded-full animate-spin"></div>
                          <span>Connecting...</span>
                        </>
                      ) : (
                        <span>Connect</span>
                      )}
                    </span>
                  </Button>
                </form>
              </Form>
            </CardContent>
          </Card>

          <Alert className="relative overflow-hidden border-0" style={{ background: 'transparent', padding: 0 }}>
            {/* Gradiente de fundo azul */}
            <div className="absolute inset-0 rounded-lg bg-gradient-to-r from-blue-900/20 via-blue-900/5 to-white/[0.01]"></div>
            
            {/* Efeito de brilho sutil */}
            <div className="absolute inset-0 rounded-lg bg-gradient-to-t from-blue-500/10 to-transparent"></div>
            
            {/* Conteúdo do Alert */}
            <div className="relative z-10 p-4">
              <div className="flex gap-3">
                <AlertCircle className="h-4 w-4 text-blue-400 mt-0.5" />
                <div>
                  <AlertTitle className="text-blue-400 font-medium mb-1">Security Notice</AlertTitle>
                  <AlertDescription className="text-sm leading-relaxed text-gray-300">
                    Your API Key and Secret are sent to our server and stored only in your browser session. They are never saved to a database. For optimal security, we recommend creating a read-only API key with no withdrawal permissions.
                  </AlertDescription>
                </div>
              </div>
            </div>
          </Alert>
        </div>
      </div>
      
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Kanit:wght@100;200;300;400;500;600;700;800;900&display=swap');
        
        .kanit-title {
          font-family: "Kanit", sans-serif;
          font-weight: 600;
          font-style: normal;
          letter-spacing: -0.01em;
        }
        
        @keyframes scanLight {
          0% {
            transform: translateX(-100%);
            opacity: 0;
          }
          10% {
            opacity: 1;
          }
          90% {
            opacity: 1;
          }
          100% {
            transform: translateX(300%);
            opacity: 0;
          }
        }
        
        @keyframes scanLightFast {
          0% {
            transform: translateX(-100%);
            opacity: 0;
          }
          10% {
            opacity: 1;
          }
          90% {
            opacity: 1;
          }
          100% {
            transform: translateX(400%);
            opacity: 0;
          }
        }
        
        @keyframes float {
          0%, 100% { transform: translateY(0px); }
          50% { transform: translateY(-10px); }
        }
        
        .animate-float {
          animation: float 3s ease-in-out infinite;
        }
      `}</style>
    </>
  );
}