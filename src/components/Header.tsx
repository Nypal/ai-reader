import { useState, useEffect } from 'react';
import { Moon, Sun, BookOpen } from 'lucide-react';
import './Header.css';

export default function Header() {
    const [theme, setTheme] = useState<'light' | 'dark'>(() => {
        const savedTheme = localStorage.getItem('theme');
        const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        return (savedTheme === 'dark' || (!savedTheme && prefersDark)) ? 'dark' : 'light';
    });

    useEffect(() => {
        document.documentElement.setAttribute('data-theme', theme);
    }, [theme]);

    const toggleTheme = () => {
        const newTheme = theme === 'light' ? 'dark' : 'light';
        setTheme(newTheme);
        document.documentElement.setAttribute('data-theme', newTheme);
        localStorage.setItem('theme', newTheme);
    };

    return (
        <header className="app-header">
            <div className="container header-container">
                <div className="logo-section">
                    <BookOpen className="logo-icon" size={28} />
                    <h1 className="logo-text">NeuralReader</h1>
                </div>

                <div className="header-actions">
                    <button
                        className="theme-toggle"
                        onClick={toggleTheme}
                        aria-label="Toggle dark mode"
                    >
                        {theme === 'light' ? <Moon size={20} /> : <Sun size={20} />}
                    </button>
                </div>
            </div>
        </header>
    );
}
