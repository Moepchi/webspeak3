import os
from pathlib import Path

from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait


BASE_URL = os.environ.get("BASE_URL", "https://webspeak3.de/")
RESULTS = Path("test-results")
RESULTS.mkdir(exist_ok=True)


def wait_for_text(driver: webdriver.Safari, selector: str, text: str) -> None:
    WebDriverWait(driver, 15).until(
        lambda current: text in current.find_element(By.CSS_SELECTOR, selector).text
    )


def check_page(driver: webdriver.Safari, width: int, height: int, label: str) -> None:
    driver.set_window_size(width, height)
    driver.get(BASE_URL)

    wait_for_text(driver, "h1", "TeamSpeak 3")
    assert "WebSpeak3" in driver.title

    client_link = driver.find_element(By.CSS_SELECTOR, 'a[href="https://client.webspeak3.de/"]')
    demo_link = driver.find_element(By.CSS_SELECTOR, 'a[href="https://demo.webspeak3.de/"]')
    assert client_link.is_displayed()
    assert demo_link.is_displayed()

    english_button = driver.find_element(By.CSS_SELECTOR, ".lang-switch button:last-child")
    driver.execute_script("arguments[0].click()", english_button)
    WebDriverWait(driver, 10).until(
        lambda current: any(
            "Enter a server. Connected." in heading.text
            for heading in current.find_elements(By.CSS_SELECTOR, "h2")
        )
    )

    connect_demo = driver.find_element(By.CSS_SELECTOR, ".connect-demo")
    assert connect_demo.is_displayed()
    assert "voice.teamspeak.com" in connect_demo.text

    driver.save_screenshot(str(RESULTS / f"safari-{label}.png"))


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
