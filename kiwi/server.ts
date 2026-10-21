import { NeneServer, Brightness, ColorScheme, Density, Theme } from "@neneys/ui"

console.log("Date: ", new Date().toISOString())
console.log("Starting NeneServer for Kiwin...")

const theme = Theme({
    colorScheme: ColorScheme({
        brightness: Brightness.light,

        background: "#F5F7F2",
        foreground: "#17221C",

        card: "#FFFFFF",
        cardForeground: "#17221C",

        popover: "#FFFFFF",
        popoverForeground: "#17221C",

        primary: "#087F5B",
        primaryForeground: "#F4FFF9",

        secondary: "#DDEFE7",
        secondaryForeground: "#14523F",

        muted: "#E8EEE9",
        mutedForeground: "#64736A",

        accent: "#F4B942",
        accentForeground: "#3A2905",

        destructive: "#D94F4F",
        destructiveForeground: "#FFF7F7",

        border: "#CBD8D0",
        input: "#CBD8D0",
        ring: "#F4B942",

        chart1: "#087F5B",
        chart2: "#F4B942",
        chart3: "#E76F51",
        chart4: "#6C63FF",
        chart5: "#36A9A0",
    }),

    radius: 0,
    scaling: 1,
    surfaceOpacity: 0.92,
    surfaceBlur: 6,
    density: Density.defaultDensity,
});

NeneServer({
    port: 8888,
    uiPath: "./interfaces",
    callbackPath: "./callbacks",
    verbose: true,
    themeLight: theme,
    themeDark: theme,
})

