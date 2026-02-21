import { useState, useEffect } from 'react';
import { Moon, Sun, BookOpen, Coffee } from 'lucide-react';
import './Header.css';

export default function Header() {
    const [theme, setTheme] = useState<'light' | 'dark' | 'sepia'>(() => {
        const savedTheme = localStorage.getItem('theme') as 'light' | 'dark' | 'sepia' | null;
        if (savedTheme) return savedTheme;
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        return prefersDark ? 'dark' : 'light';
    });

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);

    return (
        <header className="app-header">
            <div className="container header-container">
                <div className="logo-section">
                    <BookOpen className="logo-icon" size={28} />
                    <h1 className="logo-text">NeuralReader</h1>
                </div>

                <div className="header-actions">
                    <div className="theme-segmented-control" role="group" aria-label="Theme Selection">
                        <button
                            className={`theme-pill ${theme === 'light' ? 'active' : ''}`}
                            onClick={() => { setTheme('light'); document.documentElement.setAttribute('data-theme', 'light'); localStorage.setItem('theme', 'light'); }}
                            aria-label="Light Mode"
                            title="Light Mode"
                        >
                            <Sun size={18} />
                        </button>
                        <button
                            className={`theme-pill ${theme === 'dark' ? 'active' : ''}`}
                            onClick={() => { setTheme('dark'); document.documentElement.setAttribute('data-theme', 'dark'); localStorage.setItem('theme', 'dark'); }}
                            aria-label="Dark Mode"
                            title="Dark Mode"
                        >
                            <Moon size={18} />
                        </button>
                        <button
                            className={`theme-pill ${theme === 'sepia' ? 'active' : ''}`}
                            onClick={() => { setTheme('sepia'); document.documentElement.setAttribute('data-theme', 'sepia'); localStorage.setItem('theme', 'sepia'); }}
                            aria-label="Sepia Mode"
                            title="Sepia Mode"
                        >
                            <Coffee size={18} />
                        </button>
                    </div>
                </div>
            </div>
        </header>
    );
}
