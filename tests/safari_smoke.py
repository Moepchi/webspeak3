import os
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


BASE_URL = os.environ.get("BASE_URL", "https://client.webspeak3.de/")
RESULTS = Path("test-results")
RESULTS.mkdir(exist_ok=True)


def wait_for_text(driver: webdriver.Safari, selector: str, text: str) -> None:
    WebDriverWait(driver, 15).until(
        lambda current: text in current.find_element(By.CSS_SELECTOR, selector).text
    )


def check_page(driver: webdriver.Safari, width: int, height: int, label: str) -> None:
    driver.set_window_size(width, height)
    driver.get(BASE_URL)

    wait_for_text(driver, ".ts-app-title", "WebSpeak3")
    assert "WebSpeak3" in driver.title

    capabilities = driver.execute_script(
        """
        return {
          secureContext: window.isSecureContext,
          mediaDevices: Boolean(navigator.mediaDevices),
          getUserMedia: typeof navigator.mediaDevices?.getUserMedia === 'function',
          audioContext: typeof (window.AudioContext || window.webkitAudioContext) === 'function',
          webSocket: typeof window.WebSocket === 'function'
        };
        """
    )
    assert capabilities["secureContext"]
    assert capabilities["mediaDevices"]
    assert capabilities["getUserMedia"]
    assert capabilities["audioContext"]
    assert capabilities["webSocket"]

    connections_menu = driver.find_element(By.CSS_SELECTOR, ".ts-menubar-dropdown .ts-menubar-item")
    driver.execute_script("arguments[0].click()", connections_menu)
    connect_item = WebDriverWait(driver, 10).until(
        lambda current: current.find_element(By.CSS_SELECTOR, ".ts-menu .ts-menu-item")
    )
    driver.execute_script("arguments[0].click()", connect_item)
    dialog = WebDriverWait(driver, 10).until(
        lambda current: current.find_element(By.CSS_SELECTOR, ".ts-connect-dialog")
    )
    assert dialog.is_displayed()
    assert len(dialog.find_elements(By.CSS_SELECTOR, "input")) >= 3

    driver.save_screenshot(str(RESULTS / f"safari-client-{label}.png"))


def main() -> None:
    options = webdriver.SafariOptions()
    driver = webdriver.Safari(options=options)
    try:
        check_page(driver, 1440, 1000, "desktop")
        check_page(driver, 390, 844, "mobile")
    finally:
        driver.quit()


if __name__ == "__main__":
    main()
